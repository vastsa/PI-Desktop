# 10. WorkBuddy Benchmark — UX Spec Proposal

> Source: hands-on walkthrough of WorkBuddy v5.3.5 (macOS, Electron) on
> 2026-07-25, captured via CDP screenshots. This doc records what WorkBuddy
> does UX-wise, and specs which patterns PI-Desktop should adopt, adapt, or
> reject. Baseline shell IA: [01-ui-ia](01-ui-ia.md).

## 1. What WorkBuddy is (observed)

A consumer/prosumer "AI work companion": chat-first desktop app whose unit of
work is a **Task** (a conversation with a goal), organized under **Spaces /
Projects**, extended by a marketplace of **Experts (personas) · Skills ·
Connectors**, plus **Automations** (scheduled tasks). It is persona- and
template-heavy; PI-Desktop is developer- and workspace-heavy. The value here
is interaction patterns, not product scope.

## 2. Observed IA

```text
+----------------------------+------------------------------------------+
| Sidebar                    | Main pane                                |
|  收起 · 搜索 · 筛选 (top)   |  Per-destination header (tabs/actions)   |
|  新建任务                   |  Content                                 |
|  助理 (local assistant)     |                                          |
|  项目 (Projects)            |  Chat destination:                       |
|  专家·技能·连接器 (flyout)   |   transcript + floating composer          |
|  自动化 (Automations)       |   composer: + · 权限选择 · 模型选择 ·      |
|  更多 (flyout: 文件/知识库/  |            语音 · 发送                    |
|        灵感)                |   AI-content disclaimer footer            |
|  任务 (N)  — recent tasks   |                                          |
|  空间 (N)  — spaces         |                                          |
|  Footer: avatar · 通知 · 分享|                                          |
+----------------------------+------------------------------------------+
```

Notable per-screen details:

- **Chat / Task**: title in header with search / share / history / panel
  icons; per-message action row (copy, like/dislike, TTS, retry, share, more)
  plus a **token-cost chip** (`共消耗 ◇2.85`) and model badge inline; global
  disclaimer "内容由 AI 生成，请核实重要信息" under the composer.
- **Composer**: single pill; placeholder teaches syntax ("@ 引用对话文件，
  / 调用技能与指令"); left cluster `+` and a **permission-mode dropdown**
  ("默认权限"); right cluster model selector ("Auto"/named model), mic, send.
- **助理 (Assistant)**: a persistent "local assistant" chat with a
  **connection status in the header** ("已连接: 微信小程序" + gear) — the
  assistant is presented as an entity with integrations, not just a thread.
- **项目 (Projects)**: landing page with hero (title, one-line value prop,
  illustration), primary CTA "新建项目", "我的项目" card list with kebab
  menus, then a **"从模版创建" template gallery** (PRD flow, market research,
  team knowledge base, delivery, bug tracking).
- **自动化 (Automations)**: tabs 定时任务 / 运行记录; empty state (icon +
  one-liner + primary CTA); below it a **template gallery** of ~12 recipes
  (daily AI news, weekly report, meeting prep…) so the empty state still
  offers one-click value.
- **专家·技能·连接器**: sidebar item opens a 3-way flyout; the page has
  segmented tabs (专家/技能/连接器), search, "我的专家", featured-scenario
  banner cards, category chip row, sort (综合/最热/最新), and rich persona
  cards (avatar, tagline, capability tags).
- **更多**: overflow flyout for secondary destinations (我的文件, 腾讯文档,
  ima知识库, 乐享知识库, 灵感) — keeps the rail at ~6 primary items.
- **我的文件 (My Files)**: not a file manager — an **artifact browser for
  task outputs**. Tabs 任务成果 / 云端网盘 (cloud-drive sync); type filter,
  search across "文件、任务或工作空间", favorites toggle; a table
  (name / type / updated-by / updated-at / size) whose rows are **grouped by
  the task that produced them** (group header shows task name + count, e.g.
  "未分组 · 1个任务" → task → main.js / styles.css / index.html). Every
  deliverable an agent produces is findable later without reopening the
  conversation.
- **空间 (Spaces)**: a sidebar section between 任务 and the footer. A Space
  is **bound to a local directory** (hovering the space "tools" reveals a
  tooltip such as `/Users/example/Projects/tools`) and **expands inline to list
  the tasks run inside it**; row actions on hover: `+` (new task in this
  space) and `…` (manage). Tasks in both lists carry status badges — green
  dot = running, red `!` = failed. Cloud/collab Projects (项目) also appear
  in this section, so "Space" is the umbrella for "place work happens",
  local folder or shared project alike.
- **Onboarding**: the first assistant message is a structured interview
  (name/style for the agent; how to address you, city, current focus) —
  personalization by conversation instead of a form wizard.

## 3. Adopt (spec changes for PI-Desktop)

Each item below is a concrete proposal; decisions go to the decisions log.

### 3.1 Permission mode in the composer
WorkBuddy puts the permission posture next to the send button. PI-Desktop
exposes the same control as a composer chip (current effective mode:
`Ask every time / Accept edits / Auto`) opening a small menu. The menu shows
only those three modes and marks the effective selection directly; it does not
surface global-default or inherit provenance. Choosing a mode creates a
per-session override. This complements, rather than replaces, the inline
permission cards in [03-permission-ux](03-permission-ux.md) (D132).

### 3.2 Per-message meta: cost + model
Adopt the inline **token/cost chip and model badge** on assistant messages
(collapsed by default into the message action row; hover to expand
input/output/cached breakdown). Data already exists in the runtime usage
events.

**Adopted in D103 (tokens-only first cut), placement amended by D347**:
completed assistant turns show a model badge under the answer. The compact
Codex-style context inspector lives in the composer toolbar next to the model
picker and always mirrors the newest assistant turn that reported usage. The
trigger shows remaining context percentage in a small ring; clicking it
toggles a light summary panel with remaining/window counts and two unboxed
turn/speed values. Provider input/output/cache/reasoning usage stays
available as one inline exact-usage row, while tool usage is reduced to one
aggregate row with tool types, calls, and estimated tokens. Per-tool rows,
share bars, badges, and explanatory estimate copy are omitted from the default
view. Generation rate is a completed-turn snapshot rather than a live
streaming counter. The context-window total comes from the same `pi-ai` model
metadata used by the agent sidecar, with provider metadata and the default
window only as fallbacks for unknown models. Tool estimates remain separate
from exact provider totals because providers do not expose per-tool context
allocation.
Currency pricing remains deferred. Regenerate is available as a quiet action
chip next to Copy and rewrites the current turn in place (D105); when multiple
variants exist, a ChatGPT-style `current / total` pager on the root user turn
restores archived branches (D109). Completed assistant rows also expose Fork
and reversible Edit, while omitting Delete; both edits diverge into isolated
sessions so the source cache/runtime stays untouched (D134).

### 3.3 Template galleries on empty states
WorkBuddy never ships a dead empty state: Automations and Projects both pair
the empty hero with click-to-instantiate templates. **Spec**: Scheduled page
empty state gains 4–6 developer recipes (nightly test run, dependency-update
digest, PR review sweep, changelog draft); the Settings Project archive keeps
its table but gains a "Start from template" row when empty.

### 3.4 Teaching placeholder in the composer
Replace the static placeholder with a syntax-teaching one:
"Describe a task — @ to reference files, / for commands". The empty home keeps
this direct-entry surface focused on the hero, optional onboarding, and bottom
composer, without adding developer starter cards or a contextual quick-action
layer (D204/D206).

### 3.5 Overflow "More" flyout for secondary destinations
Keep the sidebar rail at ≤6 primary items. As destinations grow (Logs,
Files, Knowledge, future panels), park them under a "More" flyout instead of
lengthening the rail.

### 3.6 Conversational onboarding (first-run)
Complement the checklist onboarding (05-onboarding) with a first assistant
turn that interviews the user (project, preferred tone, guardrails) and
writes results to workspace memory/config — a form disguised as a chat.

### 3.7 Artifacts view (from 我的文件)
Sessions produce files the user later can't find without scrolling the
transcript. **Adopted first step in D128**: clicking a file artifact creates a
path-keyed, closeable work-panel tab, and successful workspace Write/Edit
artifacts open Review. **Adopted in D179**: the transcript also places a
message-scoped review card directly after each successful file mutation; its
status, +/− totals, and expandable hunks stay attached to that tool row rather
than becoming a global footer entry. These renderer tabs and cards are
transient views, not a second
persistence model; the host-owned `artifacts` table remains authoritative.
A future dedicated Artifacts destination may list files grouped by session
with name / kind / session / time columns and Finder/diff actions. Skip the
cloud-drive tab (no cloud storage in scope).

### 3.8 Workspace-scoped session tree (from 空间)
WorkBuddy nests tasks under the folder-bound Space they ran in, with `+`
(new task here) on hover and status badges (running dot / failure mark) per
task. **Adopted and extended in D093**: PI-Desktop renders every retained,
path-keyed project as a compact, independently collapsible group, followed by
a Temporary sessions group for path-less sessions. Each directory title is
the single disclosure target (chevron, folder, label, and remaining row hit
area), while `+` and overflow actions appear on hover/focus. The active project
is still the only selected host workspace; retained groups do not create
parallel workspace singletons. This supersedes D088's one-current-project
sidebar limitation while preserving its exact-path and Temporary boundaries.
**Refined in D135**: each conversation row uses a fixed leading status slot
with distinct color and geometry: accent-blue selection ring, warning-orange
breathing in-progress dot, success-green check, and error-red alert. In-progress
outranks selection, selection outranks the latest terminal outcome, and reduced
motion keeps the in-progress dot static.

## 3.9 Transcript density and user-plate alignment
WorkBuddy's task transcript keeps user turns as compact right-side plates and
assistant turns as full-width transparent prose, with quiet hover actions under
each turn. **Adopted in D101**: PI-Desktop keeps the developer-tool restraint
(no mascot, no like/dislike) but densifies row spacing, right-aligns the user
plate at `min(78%, 560px)`, softens the plate border/shadow, and shows copy
chips only on hover/focus-within. Streaming assistant answers use a thin
accent left rule instead of a heavy pulse frame.

## 4. Adapt with caution

- **Assistant-with-integrations header** ("已连接: X"): good pattern for
  showing MCP/connector health per session; adapt as a small connector
  status cluster in the context panel, not the chat header.
- **Persona marketplace**: out of scope as a store, but the **card grammar**
  (avatar/icon, one-line tagline, capability tags, category chips, sort) is
  the right template for the Plugins page as the catalog grows.
- **Voice input / TTS**: note as future; not MVP.

## 5. Reject

- **Mascot artwork** floating over the transcript — conflicts with the
  restrained developer-tool aesthetic (07-ui-design-system).
- **Like/dislike + share on every message** — no backend to serve; keep the
  action row to copy / retry / (cost chip).
- **Consumer template content** (bedtime stories, wallpapers) — replaced by
  developer recipes in §3.3.
- **Blanket AI disclaimer footer** — redundant in a tool whose every output
  is inspectable; permission UX already carries the trust surface.

## 6. Open questions

1. Does the composer permission chip write through to Settings or stay
   session-scoped? (Proposed: session-scoped, Settings unchanged.)
2. Cost chip currency: tokens only, or provider-priced estimate?
3. Scheduled templates: hardcoded or plugin-contributable?
