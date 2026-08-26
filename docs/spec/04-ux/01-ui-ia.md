# 01. UI Information Architecture

> Language: English (per ADR 0009). This describes the shipped Codex-aligned
> shell (D034+). Component detail: [08-component-spec](08-component-spec.md);
> visual tokens: [07-ui-design-system](07-ui-design-system.md); behavior:
> [09-interaction-patterns](09-interaction-patterns.md).

## 1. Goal

A clear, restrained, developer-first workbench: one window, one active
destination, chat as the home surface, tools and permissions inline.

## 2. Shell regions

```text
+----------------------------------------------------------------------+
| Platform titlebar: macOS traffic lights / Windows/Linux actions     |
+------------------+--------------------------------+------------------+
| Sidebar (~275px) | Main pane (active destination) | Work panel       |
|                  |  chat home / transcript        |  (optional,      |
|                  |  or Extensions page            |   resizable      |
|                  |                                |   244–720px)     |
|  Sessions     +↕ |                                | surface          |
|   Recent rows ↕  |                                |                  |
|  Projects      + |                                | ◫ | App.tsx  ⌄ × |
|   Project A      |                                | > |              |
|   Project B      |                                | ◎ | Active       |
| Footer [⚙][plug][☾][bell] |  Floating composer (chat) |   | resource     |
+------------------+--------------------------------+------------------+
```

- **Sidebar**: primary navigation — path-less conversations under a compact
  **Sessions** section with new-session and sort actions, retained open-project
  groups under a following **Projects** section with a persistent new-project
  action, and the WorkBuddy-inspired footer. The footer keeps compact Settings,
  Extensions, and notification icon actions; Pull requests and Scheduled
  are intentionally omitted from the home sidebar. Each retained project is a
  path-keyed tab/group that can be
  collapsed independently. Project and conversation rows expose
  non-destructive pin/archive actions, an independent conversation-branch
  command, and sortable views. Projects not retained in the sidebar remain
  discoverable through Settings → Project archive.
  Collapsible to an icon rail (Cmd/Ctrl+B).
- **Product identity**: runtime shell copy uses `PI-Desktop`; the home hero and
  sidebar reuse the canonical `build/icon_1024.png` logo, while composer prompt
  rows have no leading brand icon and session-creation controls use a dedicated
  message-plus icon. On
  Windows/Linux, the expanded sidebar begins with a keyboard-accessible Home
  brand and Search plus Collapse sidebar controls at the right; activating the
  brand returns the main pane to chat. The macOS expanded sidebar omits the
  logo/title brand and places only Search and Collapse sidebar at the right of
  the traffic-light row. `Codex` remains only an external import source or a
  design-reference term.
- **Main pane**: exactly one destination at a time; destinations replace the
  pane (they are pages, not modals). Once Settings or Extensions is selected,
  bootstrap completion and background refreshes must not replace that
  destination with the chat home; only an explicit navigation action may do so.
  The outer pane stays fluid while the sidebar is collapsed, but the centered
  chat content band tightens to 640px from its expanded 760–768px ceiling so
  the wider shell does not create an over-wide, low-density reading surface.
- **Titlebar**: platform-native desktop chrome (D118). macOS uses
  `hiddenInset` traffic lights and the system application menu. The expanded
  sidebar keeps Search and Collapse sidebar in the same 46px row, aligned to
  the right outside the traffic-light safety area; no logo/title is rendered
  there, including in fullscreen. When the work panel is open, the native
  window controls stay at the conversation pane's right edge while the panel
  header uses its full width for the active resource.
  Windows/Linux use a menu-free frameless 46px row with sidebar actions on the
  left and accessible minimize / maximize-or-restore / close controls at the
  right edge of the conversation pane (D129). When the work panel is open, the
  controls stay with the conversation pane and the panel header uses its full
  width for resource actions. Destination history is shortcut-only (`Cmd/Ctrl+[` and
  `Cmd/Ctrl+]`); no back/forward buttons are rendered. The main titlebar has no
  notification action; the durable local inbox opens from the sidebar footer
  bell instead (D130/D117).
- **Work panel**: docked right column (not an overlay) opened by an artifact
  or `Cmd/Ctrl + J`. File, URL, browser-preview, and successful workspace-edit
  artifacts create their resources atomically. A combined panel entry keeps
  Browser and in-scope plugin views available while
  the panel is visible; opened-but-inactive views show a quiet dot and the active
  resource has a restrained edge marker. The 46px content header names the
  current resource, closes it directly, and opens a compact switcher for all
  current session resources. File paths stay distinct in that switcher while
  plugin views deduplicate by view reference. `Cmd/Ctrl + J` toggles the
  active session's retained panel context — revealing it without creating a
  resource tab and collapsing it without discarding one; the create trigger
  remains unavailable while the panel is closed. A
  successful active-session workspace Write/Edit artifact opens Review;
  scratch, failed, and background-session writes never steal focus. Width is
  drag-resizable from 244px to 720px and remains at
  its fixed committed width while open. The sole panel-level control collapses
  the panel;
  each session retains its own runtime open state, tab set, active tab, and
  Browser resource in renderer memory. Selecting another session swaps the
  visible panel context without deleting either session's state; selecting a
  workspace without an active conversation hides the panel rather than
  reinterpreting relative resources. Background artifacts update only their
  originating session's retained panel context and never open, activate, or
  resize the visible panel. Startup is closed with no retained session
  contexts, and only the preferred panel width persists across launches.
  The work panel remains a fixed-width in-flow column beside MainChat, with a
  matching native reservation while visible (ADR 0122). Opening it reserves
  the committed width before presentation so MainChat keeps its width when the
  display work area allows it; collapse and final-resource close release the
  reservation after the exit animation and return the window to its base
  bounds. On constrained windows the panel stays fixed and chat absorbs only
  the unavoidable shortfall. Native window edges resize chat and never the
  panel. Maximized/fullscreen is unaffected; moving between displays or
  changing a display work area reconciles the target normally. Persisted base
  bounds exclude temporary panel reservation. Background artifacts never
  change the visible panel or reservation (D163, D255, ADR 0122).
  Replaces the former context-panel overlay; workspace/model/status info lives
  in the composer chips and Settings instead.
- **Composer**: workspace-agnostic floating pill anchored to the conversation
  destination — centered empty-home content above a bottom-reserved composer
  (D111/D204/D206), bottom-docked in a transcript, with no project / Local / branch
  rail (D095).
  Its left-of-input operating-mode chip is the sole active-session control for
  **Agent**, **Plan**, and **Goal**. Plan shows the same Agent's planning state;
  Goal shows the same approval boundary for an outcome contract. Both keep the
  permission-mode chip and expose their host-written immutable `.pi/plan/*.md`
  or `.pi/goal/*.md` artifact opener after submission. The conversation top bar
  retains only the task title and window actions; the Composer owns model and
  reasoning selection as well as mode control.
- **Backend status capsule**: appears under the titlebar while the backend
  restarts or is fatally degraded (D080), with an Open-logs action.

## 3. Destinations

### 3.1 Chat home (default)
- Empty state: a restrained hero title ("What can I help you build?" — project name
  becomes a dotted-underline button when a workspace is open), a short muted
  supporting line, an optional first-run checklist, and a bottom-reserved
  composer. Task entry starts directly in the composer; no developer starter
  cards or contextual quick-action row are rendered (D204/D206).
- With transcript: message stream + tool disclosure rows (D071), a contextual
  message-scoped review card immediately after each successful workspace
  Write/Edit row, docked composer, and a session-scoped permission card inline.
  The card reads the message's durable review snapshot rather than the current
  Git diff, so it stays visible after commit. It shows the file status and
  addition/deletion counts, expands the exact message hunks in place, and
  offers guarded rollback; it is not a global transcript entry. A background
  session's message, tool, and permission events never replace or cover the
  visible conversation.

### 3.2 Sidebar project groups

- **Sections**: the compact `Sessions` heading precedes `Projects` and owns
  path-less conversation creation plus the existing sort/archive-view menu. Its
  toolbar places sorting before new-session creation. Both headings keep quiet
  glyph actions and also accept a right-click create menu on the heading or empty
  list chrome so section creation stays discoverable
  without extra chrome. Its list shows at most five compact rows (140px) before
  scrolling internally, so standalone work stays visible without displacing
  project navigation. The following `Projects` heading exposes the
  folder-picker action; retained project groups use the remaining height and
  scroll independently.
- **Identity**: each group is keyed by the normalized full project path, never
  by a potentially ambiguous folder basename.
- **Header**: project name, active state, disclosure, new-task action, and an
  overflow menu. The directory title is one full-row disclosure target;
  collapse/expand affects only child visibility, and adjacent groups form one
  dense tree rather than detached cards. Hovering or focusing the project title
  reveals the full project path.
- **Project actions**: open folder reveals the project directory; pin/unpin
  changes presentation priority; archive/restore hides or restores the group in
  the default view; close removes the retained tab without deleting or
  archiving project/session data.
- **Conversation actions**: pin/unpin, archive/restore, and delete remain
  separate actions. Archive never removes the transcript. Open folder is a
  project action, not a conversation action.
- **Sort**: user-facing modes are Recently updated, Created date, Oldest
  first, and Name. Pinned rows precede unpinned rows. A legacy persisted
  `manual` value remains readable but does not imply a drag-reorder gesture.
- **Conversation list**: each group shows the ten most-recent sessions in the
  active sort order by default; the remainder folds behind a **Load N more…**
  row that expands the full time-grouped list on click. Pinned rows precede
  unpinned rows and are never pushed behind the fold; the expansion state is
  not persisted.
- **Standalone sessions**: path-less sessions remain in the separate Sessions
  section and never inherit the last active project's workspace.
- **Concurrency**: the shell selects one visible project at a time, while
  agent run state remains keyed by session. Switching project tabs does not
  cancel a background turn. Background events update only their originating
  session and never change the active session, page, project, or keyboard
  focus.

### 3.3 Pull requests
Segmented Open/Draft/All filters with counts; rows carry icon plate, number,
title, status badge, branch meta, external link, and "Review with agent"
(creates a chat turn). Requires an active workspace and `gh`.

### 3.4 Scheduled
Create card + task rows (cadence/enabled badges, prompt preview, last run,
Run now / toggle / Delete). Run now opens a session seeded with the prompt.
New tasks default to Agent. A migrated Plan or Goal task is allowed to remain
stored, but an unattended run is explicitly rejected before provider, artifact,
or queue work with `PLAN_REQUIRES_INTERACTIVE_SESSION`; it cannot display or
auto-approve a contract.
The user must explicitly switch it to Agent before enabling unattended
execution.

### 3.5 Extensions

The Extensions destination is a focused plugin surface with a compact header and
only two tabs: **Installed** and **Marketplace**. Installed groups plugin rows
by state — Needs attention / Updates available / Active / Turned off — inside
one hairline-separated panel. Marketplace remains the browse/install card grid.
MCP, Skills, and Subagents are not tabs or sections of Extensions.

### 3.6 Settings (full-page takeover)
### 3.6 Settings (full-page takeover)
Settings replaces the whole shell (D063): back-to-app + search + a grouped
settings rail. The Agent group contains independent Skills, MCP, and Subagents
destinations alongside Instructions and Model configuration; selecting one
changes the page destination rather than a tab inside a shared capability panel.
Appearance lives inside Basics; global AI behavior (permissions and context
management) lives inside 全局 AI; keyboard shortcuts and global/project
instructions have their own destinations; provider management lives inside
Model configuration. Import scans supported local agent stores and presents
candidates in collapsible groups. Project path is an alternate grouping
alongside the default source grouping, and every scan or grouping change starts
with all groups collapsed. Project archive owns the durable D086 Projects index
(search, add, expand, pin, archive/restore, close, and reopen) and always includes
archived records. Opening or switching a project retains a sidebar tab, selects
that project as the active workspace, and returns to chat. Other retained tabs
stay open. Extension management remains solely on the app shell's independent
Extensions destination described in §3.5. Settings > Agent has the following
shared capability contract:

- Each capability destination starts with a quiet localized description and
  scope note, then uses the same neutral elevated Settings surface as the other
  destinations; no capability page has a decorative hero, colored top bar, or
  separate visual theme.
- Skills and MCP use stacked global/project card blocks in one column. Each
  block has a quiet heading row with a scope title, scope description,
  resolved `.agents` path, localized count, and its actions; the project
  block shows a recent-project picker. Project records take precedence over
  global records.
- Skills have one native **Import** action per surface. It accepts exactly one
  file and physically copies it into the selected `.agents/skills` directory.
- MCP has one **Add** action per surface. Add and Edit open the existing
  `McpEditorSheet` as a modal overlay with stdio/HTTP branches, validation,
  duplicate checks, locked edit ids, scope text, and Test connection feedback.
- Subagents use one full-width global surface under `~/.agents/subagents`; they
  have no project picker, project surface, or project-level toggle.
- All three lists flow at natural page height, render a quiet centered empty
  state inside the panel, dim disabled rows, and store enablement in app-local
  state rather than capability files. Loading and project changes render
  skeleton rows with the same anatomy and disable competing controls until the
  host refresh completes.

## 4. Overlays

| Overlay | Trigger | Notes |
|---|---|---|
| Command palette | Cmd/Ctrl+K (also Cmd/Ctrl+Shift+P per D014) | builtin + plugin commands |
| Model menu | Composer-right model × reasoning chip | configured provider/model choices + settings entry (D091) |
| Profile menu | sidebar footer | Settings / Logs / Theme cycle (D041) |
| Notification inbox | sidebar footer bell | All/Unread views, task completion/failure rows, mark-all-read and clear actions (D130/D117) |
| Toasts | events (plugin toast, backend restored, copy) | top-center; 4s default, 8s for errors |

## 5. Navigation model

- `page` state: `chat | pulls | scheduled | plugins | settings`; `chat` is the
  conversation-surface route, not an operating mode. The project
  archive is the `projects` settings tab rather than a standalone page.
- Destination history is linear; `Cmd/Ctrl+[` and `Cmd/Ctrl+]` traverse it
  without persistent back/forward chrome.
- Selecting a project tab reuses `project.set` when its path differs from the
  selected host workspace and keeps the other tabs retained.
- Selecting a project-scoped thread activates its project before switching to
  `chat`. Selecting a temporary thread clears the visible active workspace
  before loading it.
- Empty home has three explicit session states: a project-bound session shows
  the existing project-underlined welcome; a temporary session shows dedicated
  temporary-chat copy with no project underline or folder-open action; and no
  active session keeps the generic welcome title.
- New task resolves the current project or temporary group by its most recent
  session: if that session has `messageCount = 0`, it is selected and reused;
  otherwise a durable empty session is created immediately and appears in the
  sidebar. Repeated clicks therefore keep one empty slot per visible group;
  an empty slot remains persisted until the user deletes or archives it.

## 6. Keyboard map (IA level)

| Keys | Action |
|---|---|
| Cmd/Ctrl+K, Cmd/Ctrl+Shift+P | command palette |
| Cmd/Ctrl+B | toggle sidebar |
| Cmd/Ctrl+[ | previous destination |
| Cmd/Ctrl+] | next destination |
| Cmd/Ctrl+N | new task |
| Cmd/Ctrl+O | open project |
| Cmd/Ctrl+, | settings |
| Cmd/Ctrl+. | abort current run |
| Enter / Shift+Enter | send / newline (configurable Enter-to-send) |
| Esc | dismiss overlay/menu |

## 7. State-dependent chrome

- No provider configured → blocking guidance toward Settings before first run
  (`MODEL_NOT_CONFIGURED`).
- No workspace → home hero without project underline; Pull requests shows a
  workspace-required empty state. The composer never renders a workspace rail.
- Background project session → the originating project row retains its
  running/error indicator. Selected shell state can move independently while
  the session tool root remains bound to its durable project; its artifacts are
  retained in that session's work-panel context without opening or activating
  tabs over the currently selected project. Messages, tool events, permission
  requests, and panel resources remain scoped to that session. Explicitly
  opening the conversation restores its retained panel context and reveals any
  pending permission card with its original deadline.
- Completed/failed turn not already visible → host-core appends one durable
  inbox row. A result shown in the visible, focused current chat and every
  `aborted` turn append none. Background sessions and any turn finishing while
  the window is unfocused still append. The sidebar footer bell badge shows the
  unread count; selecting a row marks it read and activates its bound
  project/session.
  Electron additionally presents a native system notification only when the
  app window is unfocused, and clicking it focuses the window before activating
  the same session (D117). Receiving either the durable or native notification
  event never navigates by itself; only explicit activation does.
- Backend degraded → status capsule (restarting) or fatal banner with Open
  logs (D080); composer submits are rejected with readable errors while down.
  - Plan/Goal checkpoint → the originating session shows only the structured title
  and an opener for its immutable `.pi/plan/*.md` artifact. The renderer retains the latest
  proposal/execution snapshot per session only for the current renderer
  lifetime, updated by live Host events; only a live `pending` row forms the
  approval gate. Reload through `plans.pending` while the same Host remains
  alive restores a still-pending row with its original deadline. Rejected,
  expired, approved/completed, and interrupted terminal cards are not
  rehydrated; a terminal card may remain visible and non-actionable only until
  renderer reload. Reject, expiry, or interruption clears the approval gate,
  leaves the session in its contract state and editable, and requires a later turn to
  create a new artifact. While pending, the draft remains visible but
  read-only and only Approve or Reject actions are enabled. Host/app restart
  interrupts prior work before RPC with no replay or stale action; pending
  unapproved work remains Plan, while already-approved interrupted execution
  remains Agent. The UI is not required to present that interrupted terminal
  snapshot after restart.

## 8. i18n

English is the source locale; zh-CN ships in parallel for shell chrome
(labels asserted by US-UI e2e scenarios). Copy rules live in
[02-i18n-english-first](02-i18n-english-first.md).
