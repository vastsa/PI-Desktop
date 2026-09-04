/**
 * Dual-locale product changelog for PI-Desktop app releases.
 *
 * English is the source of truth (ADR 0009). The zh-CN catalog mirrors the
 * same versions and bullet counts so in-app "what's new" can follow the
 * active UI locale without a network fetch or renderer-supplied feed URL.
 *
 * Update this file before cutting a release tag. GitHub release bodies may
 * still be auto-generated for the web; they are not the in-app source.
 * Stable product versions only — omit pre-releases.
 */

export type ChangelogLocale = "en" | "zh-CN";

export type ChangelogEntry = {
  /** Semver without a leading `v`, matching apps/desktop package version. */
  version: string;
  /** Optional ISO date (YYYY-MM-DD) of the release. */
  date?: string;
  /** Short user-facing highlights; keep each line one idea. */
  highlights: string[];
};

const enEntries: ChangelogEntry[] = [
  {
    version: "0.12.4",
    date: "2026-09-04",
    highlights: [
      "Keep the right work panel inside the application window so MainChat reflows like the left sidebar.",
      "Resize the work panel from its inner divider with pointer or keyboard controls while preserving window bounds.",
      "Deduplicate paged transcript reads during session switching for smoother navigation.",
      "Add a native macOS sidebar surface treatment without changing the sidebar's layout behavior.",
    ],
  },
  {
    version: "0.12.3",
    date: "2026-09-03",
    highlights: [
      "Show context usage against the selected model's published context window.",
      "Keep model-specific context limits consistent across provider settings, the Composer, and the runtime.",
      "Keep Composer contextual guidance stable while switching models and during active turns.",
    ],
  },
  {
    version: "0.12.2",
    date: "2026-09-03",
    highlights: [
      "Fix user message row appearing before host round trip completes.",
      "Clear draft prompt before sending to prevent stale content.",
      "Settle long transcripts under a skeleton veil for smoother rendering.",
    ],
  },
  {
    version: "0.12.1",
    date: "2026-09-03",
    highlights: [
      "Keep models enabled for subagent delegation available after saving provider settings and restarting the app.",
      "Keep live replies visible when reopening sessions.",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-09-02",
    highlights: [
      "Coordinate concurrent subagents over the Agent2Agent (A2A) protocol: discover running peers as Agent Cards, exchange durable tasks and typed messages, and stream task updates — replacing the previous in-process peer messaging.",
    ],
  },
  {
    version: "0.11.4",
    date: "2026-09-01",
    highlights: [
      "Publish native macOS Intel DMG and ZIP installers alongside Apple Silicon builds.",
      "Keep macOS updater feeds unified across both native architectures.",
    ],
  },
  {
    version: "0.11.3",
    date: "2026-08-31",
    highlights: [
      "Assign each subagent its own model from a delegation catalog, or let it inherit the parent conversation's pick.",
      "Let concurrent subagents message each other with topic-filtered, threaded peer messaging.",
      "Run structured roundtable discussions where multiple subagents debate a topic across rounds and summarize the outcome.",
      "Keep model configuration controls — delegation checkbox, custom model section, and font sizes — harmonized across panels.",
      "Replace the delegation hint text with a cleaner icon tooltip.",
    ],
  },
  {
    version: "0.11.2",
    date: "2026-08-31",
    highlights: [
      "Switch between recent conversations without the chat area flashing: each one keeps its own pane and reappears exactly as you left it, scroll position included.",
      "Return to a conversation you had scrolled up in and land back at that spot, while a session opened for the first time still starts at its newest turn.",
      "Keep reading the current conversation while a new one loads, instead of watching the transcript dim.",
      "Retry an edited prompt even when you left the text unchanged.",
      "Keep working on the task at hand after an automatic context compaction, instead of the agent picking up an older request.",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-08-30",
    highlights: [
      "Set up a provider in one discovery-driven form that asks the AI service for its own models before falling back to the bundled catalog.",
      "Pick a model from a searchable list that shows capability badges and context size, sourced from the models.dev catalog.",
      "Override attachment capabilities and the default thinking level per model binding, and see only the thinking levels a model publishes.",
      "Read a lone subagent delegation as its own card with lifecycle rows, and scroll an expanded delegate run instead of stretching the transcript.",
      "Keep the conversation outline reachable while history still loads, and see a skeleton instead of an empty list while sessions load.",
      "Paste a large block of text into the composer and have it spill into a session file, with typing kept off the reflow path.",
      "Keep a window where you dropped it when dragging across displays, and keep the titlebar band reserved on macOS destination pages.",
      "Lose fewer turns to rejected file and search tool calls, and to a command timeout given in milliseconds.",
    ],
  },
  {
    version: "0.10.9",
    date: "2026-08-28",
    highlights: [
      "Manage skills, subagents, and MCP servers from one capability workbench in Settings, with level filters, search, and confirmed removal.",
      "Keep the capability workbench and the settings top band legible in both themes, with correctly sized toolbar and empty-state controls.",
      "Keep long conversations responsive while scrolling, switching sessions, and hovering the minimap, without the transcript jumping into place.",
      "Load every transcript line written by older builds instead of showing a past session as empty.",
      "Cut the transcript at the message you chose when regenerating or resending an edit, and always list a forked session in the sidebar.",
      "Judge subagent liveness by any response, cap each builtin subagent's turns, and report an expired wait as still running instead of failed.",
      "Retry a transient provider failure up to four times with 1/2/4/8s waits on one shared budget per turn, and report the real attempt mid-stream.",
    ],
  },
  {
    version: "0.10.8",
    date: "2026-08-26",
    highlights: [
      "Keep Windows native window controls isolated from panel actions across the frameless shell.",
      "Give temporary chats isolated scratch workspaces so their files stay separate from project work.",
      "Restore prompt enhancement in the command launcher with a clearer bot model icon.",
      "Reveal sidebar scrollbars on hover while keeping them quiet at rest.",
    ],
  },
  {
    version: "0.10.7",
    date: "2026-08-25",
    highlights: [
      "Keep the Composer send and stop controls in one stable slot so drafts and running turns stay aligned.",
      "Keep prompt enhancement available from the command launcher without a standalone toolbar icon.",
      "Make sidebar scrollbars quieter at rest while keeping them discoverable during navigation.",
    ],
  },
  {
    version: "0.10.6",
    date: "2026-08-25",
    highlights: [
      "Show Thinking capabilities for the exact model selected in the Composer, including before a new session is created.",
      "Start new sessions at the selected reasoning model's strongest published level.",
    ],
  },
  {
    version: "0.10.5",
    date: "2026-08-25",
    highlights: [
      "Keep Windows window controls isolated from panel actions across the frameless shell.",
      "Open Windows project folders and files reliably, including paths with the extended-length prefix.",
      "Edit CRLF files without changing their original line-ending style.",
    ],
  },
  {
    version: "0.10.4",
    date: "2026-08-25",
    highlights: [
      "Show only configured provider models in the conversation picker, while keeping saved models available when discovery is unavailable.",
      "Keep the frameless window control band opaque so page content never shows through native controls.",
      "Keep chat width stable while the work panel is open and restore chat-only window bounds after it collapses.",
    ],
  },
  {
    version: "0.10.3",
    date: "2026-08-25",
    highlights: [
      "Improve one-shot prompt enhancement so it keeps the current draft and file references intact.",
      "Keep the composer send and stop actions aligned with the visible draft and running session.",
      "Preserve background delegation metadata across TaskWait turns and renderer reloads.",
      "Keep forked sessions' history and transcript available immediately after branching.",
    ],
  },
  {
    version: "0.10.2",
    date: "2026-08-24",
    highlights: [
      "Keep chat content and the composer comfortably centered when the sidebar is collapsed.",
      "Prepare large image attachments without loading the whole file into memory, including when replaying history.",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-08-24",
    highlights: [
      "Queue prompts sent while a run is active and deliver them in order without losing the current draft.",
      "Bound background subagents with idle and total-duration timeouts and show when a delegate times out.",
      "Load long session histories in bounded pages and fetch earlier messages as you scroll upward.",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-08-21",
    highlights: [
      "Configure multiple models per provider and switch between them directly from the composer.",
      "Manage agent capabilities in a redesigned Settings studio with clearer scope blocks and menus.",
      "Expose host clipboard history to plugins as a new capability.",
      "Keep empty sessions durable so they can be shown and reused after relaunch.",
      "Make the model picker easier to use with a clearer provider hierarchy and steady scrolling.",
      "Always report total line counts in Read results so large files can be paged reliably.",
      "Recover rate-limited streams more reliably across retries.",
      "Reveal selected files in the file manager when opening them from the Files panel.",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-08-20",
    highlights: [
      "Make pinned project icons distinct so they are easier to recognize in the sidebar.",
      "Keep subagent activity from remaining stuck on Running after it finishes.",
      "Align plugin pages and panels more closely with the rest of the app chrome.",
      "Reduce typing and send latency in the composer.",
      "Make long transcripts scroll more smoothly and avoid a flash while switching sessions.",
      "Restore the empty-home supporting line and bottom-aligned composer layout.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-08-20",
    highlights: [
      "Browse project files in the bundled Files panel and open them with the operating system's default app.",
      "Add isolated plugin-contributed views to the work panel and keep marketplace provenance and withdrawn-version status visible.",
      "Remove the built-in interactive terminal while keeping Bash output in the conversation and interactive shells in the external terminal.",
      "Retry provider rate limits in place without duplicate assistant messages, then offer Continue when the retry budget is exhausted.",
      "Use a compact context summary to see model, tool, cache, and compaction usage at a glance.",
      "Teach the five core session commands through localized slash-command hints in the composer.",
      "Keep home and conversation composers aligned while their welcome and command hints rotate smoothly.",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-08-19",
    highlights: [
      "Sign in to multiple vendor accounts and choose the account used for each provider.",
      "Use each model's capabilities to decide when image attachments are supported.",
      "Choose reasoning effort directly from the composer for models that expose it.",
      "Keep one PI-Desktop instance per data directory to prevent conflicting sessions.",
      "Organize Settings into clearer groups and simplify provider account management.",
      "Keep built-in subagents aligned with the parent conversation's permission mode.",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-08-17",
    highlights: [
      "Delegate background subagents and wait for their results without blocking the conversation.",
      "Raise the running subagent cap to 10 and apply each agent's permission scope to delegated work.",
      "Add built-in explorer and fixer subagents for common background tasks.",
      "Ask once whether closing the window should minimize to the tray or quit, then remember the choice.",
      "Let plugin panels follow the app language and color mode.",
      "Retry mid-stream rate-limit errors in the same turn instead of stopping the reply.",
      "Recover approved Plan runs after a sidecar interruption.",
      "Keep sidecar crash notices from breaking a window that is already gone.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-08-15",
    highlights: [
      "Restrict plugin file access to each plugin's declared file scope, and send deleted files to the trash for easy recovery.",
      "Show each plugin's declared file scope next to its permissions.",
      "Confine plugin network requests to each plugin's declared domain allowlist.",
      "Forward unknown plugin panel channels to the plugin so deeper integrations keep working.",
      "Stop the sidebar collapse from flickering when toggled.",
      "Make agent edits line-anchored so an interrupted edit recovers gracefully instead of ending the turn silently.",
      "Harmonize card typography hierarchy for a more consistent interface.",
      "Upgrade the desktop shell and agent runtime to the latest Electron and pi releases.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-08-14",
    highlights: [
      "Open the context usage inspector on click to see token and cache statistics.",
      "Toggle work panel visibility with a new keyboard shortcut.",
      "Keep new-task drafts out of history until the first message is sent.",
      "Add a custom global font picker with bundled OFL fonts for personalized typography.",
      "Remember recently used plugins in the launcher for faster access.",
      "Add copy session path to the context menu for developer mode.",
      "Fix font picker clipping and System default reset issues.",
      "Keep macOS PI-Desktop in the Dock and Cmd+Tab after window close.",
      "Keep chat transcript pinned when composer collapses after sending.",
      "Give the work panel a real empty state with clearer guidance.",
    ],
  },
  {
    version: "0.5.11",
    date: "2026-08-13",
    highlights: [
      "Add offline availability and metadata refresh for the plugin marketplace.",
      "Cache composer drafts per conversation for faster session recovery.",
      "Localize plugin panel titles and adapt panel window chrome.",
      "Fix mascot key colour on dark surfaces.",
      "Reduce macOS launcher shortcut latency for snappier interactions.",
    ],
  },
  {
    version: "0.5.10",
    date: "2026-08-13",
    highlights: [
      "Refine plugin panel window chrome and safe areas so plugin content stays clear of native controls.",
      "Polish the Plugins page hierarchy and reduce overview copy for a clearer extension workflow.",
      "Use the correct macOS tray template icon for a sharper menu bar appearance.",
    ],
  },
  {
    version: "0.5.9",
    date: "2026-08-13",
    highlights: [
      "Make Goal mode use automatic permission handling for a more consistent workflow.",
      "Prewarm the global plugin launcher so it opens faster, including while another app is focused.",
      "Give plugin panels native window chrome with reliable minimize, maximize, and close controls.",
      "Refresh the bilingual documentation site with complete English and Simplified Chinese guides and specifications.",
    ],
  },
  {
    version: "0.5.8",
    date: "2026-08-12",
    highlights: [
      "Restore the Windows Alt+Space global plugin launcher, including when another app is focused.",
      "Keep PI-Desktop available from the system tray when minimized across macOS, Windows, and Linux.",
      "Improve native select menu readability in light and dark themes.",
    ],
  },
  {
    version: "0.5.7",
    date: "2026-08-12",
    highlights: [
      "Add asktool questions with single-select, multi-select, custom answers, skip, and decline flows.",
      "Keep multi-question progress visible with answered, unanswered, and skipped indicators.",
      "Place interactive questions in the same composer approval surface as Plan and Goal approvals.",
      "Simplify approval cards and remember the selected approval mode for the next request.",
    ],
  },
  {
    version: "0.5.6",
    date: "2026-08-11",
    highlights: [
      "Open installed plugins from a global keyboard launcher without leaving the current workspace.",
      "Collapse expanded thinking, tool, and subagent details to keep long conversations readable.",
      "Keep task configuration available during active turns and show throughput statistics after stopping.",
      "Refine corner hierarchy across the interface for clearer visual grouping.",
    ],
  },
  {
    version: "0.5.5",
    date: "2026-08-11",
    highlights: [
      "Visualize parallel subagents and their task relationships directly in the conversation.",
      "Keep pasted file references compact and restore their chips after stopping a turn.",
      "Keep mode controls available during session creation and the transcript pinned after sending.",
      "Recover more gracefully when native tools receive an incorrect file path.",
      "Polish sidebar footer actions and wrapped links in user messages.",
    ],
  },
  {
    version: "0.5.4",
    date: "2026-08-08",
    highlights: [
      "Refine the empty-home mascot with slower idle pose changes and continuous playback on hover.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-08-07",
    highlights: [
      "Run bounded subagents behind a Task tool, with user-defined agents, pinned models, attribution, and session persistence.",
      "Manage subagents from Extensions with registry reloads and clearer read-only status.",
      "Prepare and install context checkpoints during idle time while preserving transcript history and showing compaction rows and warnings.",
      "Add Goal mode as a second contract mode and preserve pasted file references through mode commands.",
      "Restore subagent and host-backed panels when the host reconnects, with quieter routine teardown diagnostics.",
      "Polish work panel and extension surfaces with clearer metadata, controls, and dark-theme contrast.",
    ],
  },
  {
    version: "0.4.3",
    date: "2026-08-05",
    highlights: [
      "Complete the Agent-only Plan workflow with durable Markdown checkpoints, approval, and queued execution.",
      "Add project-scoped MCP servers and Skills with one Extensions scope control.",
      "Harden external path permissions and native search scoping across workspaces.",
      "Make Plan approval surfaces close after resolution and mode commands switch the active session.",
      "Long conversations compact automatically: the transcript keeps every message, marks where each compaction happened, and warns you so you can decide whether to start a fresh session.",
    ],
  },
  {
    version: "0.4.2",
    date: "2026-08-03",
    highlights: [
      "Show context cache hit rate in chat transcript header for better transparency.",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-08-02",
    highlights: [
      "Update GitHub Releases and auto-update links to the canonical PI-Desktop repository.",
      "Refresh project, plugin, and release documentation to use the PI-Desktop repository name.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-08-01",
    highlights: [
      "Plugins can now contribute skills, themes, MCP servers, resident services, and an inter-plugin message bus.",
      "The plugin SDK declares all new capability types so authors can activate them from manifest.",
      "Host core validates capability contributions and derives per-plugin permissions automatically.",
      "Agent system prompt now includes plugin-declared skills for tool-aware conversations.",
      "Plugins page redesigned with a template picker, hot reload on save, and authoring tools.",
      "Creating a plugin from a template now opens the scaffolded folder as the project.",
      "Unified work panel header menu with cleaner controls and context actions.",
      "Styles split into per-surface partials; duplicate and dead CSS removed.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-31",
    highlights: [
      "Settings project archive now shows grouped sections (Pinned / All / Archived) with per-section counts, live search, and sort controls.",
      "Work panel dock width is narrower for better layout proportions.",
      "Fix switch on-track styling in light theme.",
    ],
  },
  {
    version: "0.2.11",
    date: "2026-07-31",
    highlights: [
      "Global Search now finds chats, pages, Settings, and built-in or plugin commands in one place.",
      "Appearance controls now use theme and language preview cards, with automatic language correctly following the OS locale.",
      "Settings now has dedicated AI and Shortcuts sections for clearer navigation.",
      "The agent now loads layered AGENTS.md/CLAUDE.md project instructions, with editors for global and project AGENTS.md.",
      "Project archive now searches session titles and shows newest-first activity, session counts, timestamps, and expandable history.",
      "Fix a desktop startup failure caused by the sandboxed preload regression.",
      "Reduce the audited macOS unpacked app footprint by about 55% while retaining offline syntax highlighting and native terminal support.",
    ],
  },
  {
    version: "0.2.10",
    date: "2026-07-30",
    highlights: [
      "Add Codex/WorkBuddy-style conversation top bar with improved controls.",
      "Refresh chat transcript and markdown prose styling for better readability.",
      "Unify work panel header with context menu and animate sidebar collapse.",
      "Combine tool launchers into one create dropdown for cleaner interface.",
      "Dock work panel inside fixed window instead of expanding it.",
      "Polish top bar controls: de-duplicate toggle, protect controls, macOS alignment.",
    ],
  },
  {
    version: "0.2.8",
    date: "2026-07-29",
    highlights: [
      "Update prompts and Settings now open complete localized release notes.",
      "Work panel expansion and collapse animations feel smoother.",
      "Long conversations compact oversized tool-result batches more reliably.",
    ],
  },
  {
    version: "0.2.7",
    date: "2026-07-28",
    highlights: [
      "Markdown replies can render images, audio, and video inline.",
      "Remote images display with updated content security policy.",
      "Media markup is sanitized so only safe tags are allowed.",
    ],
  },
  {
    version: "0.2.6",
    date: "2026-07-28",
    highlights: [
      "Turn-boundary context checkpoints compact long chats without hiding history.",
      "Smoother conversation switching with cached transcripts and a stable frame.",
      "Docked tools keep a fixed width so chat stays readable beside the work panel.",
      "Project menu can open the folder in your system file manager.",
      "Composer prompt rows no longer show a leading brand icon.",
    ],
  },
  {
    version: "0.2.5",
    date: "2026-07-28",
    highlights: [
      "Work panel navigation redesigned with a clearer tool rail.",
      "Window resizing is panel-aware so layout stays predictable.",
      "Streaming renders are isolated for snappier interaction.",
      "New reasoning sessions default to maximum thinking when available.",
      "Transcript stays pinned to the latest message after you send.",
    ],
  },
  {
    version: "0.2.4",
    date: "2026-07-28",
    highlights: [
      "Composer chips keep descenders fully visible.",
      "Updated pi-ai for newer Claude models including Opus 5 support.",
    ],
  },
  {
    version: "0.2.3",
    date: "2026-07-28",
    highlights: [
      "Shell copy rewritten in plain user language across locales.",
      "Selection, CJK labels, and hover motion polish.",
      "Work panel and Settings light surfaces refined.",
      "Prerelease installs now discover newer stable GitHub releases.",
    ],
  },
  {
    version: "0.2.2",
    date: "2026-07-27",
    highlights: [
      "Plugin marketplace with official remote catalog and detail panes.",
      "Isolated plugin panels and gated high-risk APIs.",
      "Right-click section toolbars to create projects or sessions.",
      "Startup splash, smoother motion, and i18n polish.",
      "Work panel top nav supports right-click to open tools.",
    ],
  },
  {
    version: "0.2.1",
    date: "2026-07-27",
    highlights: [
      "Work panel tools are retained per conversation.",
      "Review entry is scoped to the session that made the edits.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-07-27",
    highlights: [
      "Sidebar separates projects and sessions with clearer task status.",
      "Fork or edit assistant replies; icon-only message toolbars.",
      "Workspace review entry after successful file edits.",
      "Keyboard shortcut mappings and developer mode for DevTools.",
      "pi model catalog is the authority for provider models.",
      "Thinking control sits beside mode in the composer.",
    ],
  },
  {
    version: "0.1.1",
    date: "2026-07-26",
    highlights: [
      "First public release: local-first AI coding agent desktop client.",
      "Chat and Agent modes with streaming, thinking levels, and model management.",
      "Workspace tools with permission gating, terminal, browser, and git review.",
      "Rust host core for storage, secrets, sessions, and notifications.",
      "Plugin foundation plus dual English / 简体中文 UI.",
      "Update checks against GitHub Releases (in-app where supported).",
    ],
  },
];

const zhCNEntries: ChangelogEntry[] = [
  {
    version: "0.12.4",
    date: "2026-09-04",
    highlights: [
      "将右侧工作面板保留在应用窗口内部，让 MainChat 像左侧边栏一样重新分配空间。",
      "支持通过内部拖拽条或键盘调整工作面板宽度，同时保持窗口边界不变。",
      "会话切换时去重分页转录读取，让导航更流畅。",
      "为 macOS 增加原生侧边栏表面效果，不改变侧边栏布局逻辑。",
    ],
  },
  {
    version: "0.12.3",
    date: "2026-09-03",
    highlights: [
      "根据当前选定模型发布的上下文窗口显示准确的上下文用量。",
      "在服务商设置、编辑器和运行时之间保持模型级上下文限制一致。",
      "切换模型和进行中的回合时，保持编辑器上下文提示稳定。",
    ],
  },
  {
    version: "0.12.2",
    date: "2026-09-03",
    highlights: [
      "修复用户消息行在宿主往返完成前出现的问题。",
      "发送前清空草稿提示以防止内容残留。",
      "长对话记录在骨架遮罩下结算以获得更流畅的渲染效果。",
    ],
  },
  {
    version: "0.12.1",
    date: "2026-09-03",
    highlights: [
      "保存服务商设置并重启应用后，仍可使用已启用的子智能体委派模型。",
      "重新打开会话时继续显示正在生成的回复。",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-09-02",
    highlights: [
      "让并发子智能体通过 Agent2Agent（A2A）协议协作：以 Agent Card 发现正在运行的同伴，交换可持久化的任务与类型化消息，并流式接收任务更新——取代原先的进程内同伴消息。",
    ],
  },
  {
    version: "0.11.4",
    date: "2026-09-01",
    highlights: [
      "新增原生 macOS Intel DMG 与 ZIP 安装包，并与 Apple Silicon 版本同时发布。",
      "统一两种原生架构的 macOS 更新源，应用内更新发现保持一致。",
    ],
  },
  {
    version: "0.11.3",
    date: "2026-08-31",
    highlights: [
      "为每个子智能体从委派目录中分配独立模型，或让它继承父会话的选择。",
      "让并发子智能体通过主题筛选的线程化同伴消息互相通信。",
      "运行结构化圆桌讨论，多个子智能体围绕一个话题跨轮次辩论并总结结果。",
      "统一模型配置控件——委派复选框、自定义模型区块和字体大小——跨面板保持一致。",
      "用更清晰的图标提示替代委派提示文字。",
    ],
  },
  {
    version: "0.11.2",
    date: "2026-08-31",
    highlights: [
      "在最近的会话之间切换不再闪屏：每个会话保留自己的面板，回来时与离开时完全一致，滚动位置也保留。",
      "回到之前上翻过的会话会停在原来的位置，而首次打开的会话仍然定位到最新一轮。",
      "新会话加载期间可以继续阅读当前会话，不再看到转录变暗。",
      "即使没有改动文本，也能重试已编辑的提示。",
      "自动上下文压缩后继续处理当前任务，而不是让智能体捡起更早的请求。",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-08-30",
    highlights: [
      "通过单一的自动发现表单配置服务商：优先向 AI 服务索取其自有模型列表，失败时回退到内置目录。",
      "在可搜索的模型列表中选择模型，直接查看来自 models.dev 目录的能力标签与上下文长度。",
      "为每个模型绑定单独覆盖附件能力与默认思考级别，并且只显示该模型实际公开的思考级别。",
      "单个子智能体委派以独立卡片呈现并展示生命周期行，展开的委派运行内部滚动而不再拉长转录。",
      "历史仍在加载时也能访问会话大纲，会话列表加载过程中显示骨架屏而不是空列表。",
      "向输入框粘贴大段文本时自动转存为会话文件，同时保持输入不触发重排。",
      "跨显示器拖拽窗口后保留放下的位置，macOS 目标页面继续保留标题栏区域。",
      "文件与搜索工具调用被拒、以及命令超时按毫秒给出时，不再白费一个回合。",
    ],
  },
  {
    version: "0.10.9",
    date: "2026-08-28",
    highlights: [
      "在设置中通过统一的能力工作台管理技能、子智能体与 MCP 服务，支持层级筛选、搜索与二次确认删除。",
      "让能力工作台与设置顶栏在浅色和深色主题下都清晰一致，工具栏与空状态控件尺寸正确。",
      "长会话在滚动、切换会话与悬停缩略图时保持流畅，转录内容不再跳动。",
      "完整加载旧版本写入的转录行，历史会话不再显示为空。",
      "重新生成或编辑重发时按所选消息截断转录，并确保分叉会话始终出现在侧边栏中。",
      "以任意响应判断子智能体是否存活，为每个内置子智能体设置回合上限，等待超时报告为仍在运行而非失败。",
      "服务商请求出现临时失败时，按 1/2/4/8 秒等待重试最多四次并共用同一回合预算，流式过程中报告真实的重试次数。",
    ],
  },
  {
    version: "0.10.8",
    date: "2026-08-26",
    highlights: [
      "让无边框窗口中的 Windows 原生控件与面板操作保持隔离。",
      "为临时会话提供相互隔离的临时工作区，避免文件与项目工作混在一起。",
      "在命令启动器中恢复提示增强功能，并使用更清晰的机器人模型图标。",
      "侧边栏滚动条仅在悬停时显示，同时在静止时保持低调。",
    ],
  },
  {
    version: "0.10.7",
    date: "2026-08-25",
    highlights: [
      "让输入框的发送和停止控件保持在同一稳定位置，确保草稿与运行中的回合始终对齐。",
      "通过命令启动器继续使用提示增强功能，不再显示独立的工具栏图标。",
      "让侧边栏滚动条在静止时更低调，同时在导航时保持易于发现。",
    ],
  },
  {
    version: "0.10.6",
    date: "2026-08-25",
    highlights: [
      "根据输入框中精确选中的模型显示 Thinking 能力，即使新会话尚未创建也能立即生效。",
      "新会话会以所选推理模型发布的最高强度开始。",
    ],
  },
  {
    version: "0.10.5",
    date: "2026-08-25",
    highlights: [
      "让无边框窗口中的 Windows 控件与面板操作保持隔离。",
      "可靠打开 Windows 项目文件夹和文件，包括带扩展长度前缀的路径。",
      "编辑 CRLF 文件时保持原有换行风格不变。",
    ],
  },
  {
    version: "0.10.4",
    date: "2026-08-25",
    highlights: [
      "对话模型选择器只显示已配置的供应商模型，发现不可用时仍保留已保存的模型。",
      "为无边框窗口控制区绘制不透明背景，避免页面内容穿透原生控件区域。",
      "打开工作面板时保持聊天宽度稳定，收起后恢复仅聊天窗口边界。",
    ],
  },
  {
    version: "0.10.3",
    date: "2026-08-25",
    highlights: [
      "优化一次性提示增强功能，保留当前草稿和文件引用。",
      "让输入框的发送和停止操作始终与当前草稿及运行中的会话保持一致。",
      "跨 TaskWait 轮次和渲染器重新加载继续保留后台代理的关联信息。",
      "分支会话创建后立即保留其历史记录和对话内容。",
    ],
  },
  {
    version: "0.10.2",
    date: "2026-08-24",
    highlights: [
      "收起侧边栏时，让聊天内容和输入框保持舒适的居中宽度。",
      "准备大尺寸图片附件时无需将整个文件载入内存，重新加载历史记录时同样适用。",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-08-24",
    highlights: [
      "任务运行期间发送的消息会按顺序排队，不会丢失当前草稿。",
      "为后台子代理增加空闲和总时长超时限制，并明确显示代理超时状态。",
      "长会话历史改用分页加载，向上滚动时按需获取更早的消息。",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-08-21",
    highlights: [
      "支持为每个供应商配置多个模型，并在输入框中直接切换。",
      "在重新设计的设置工作室中管理代理能力，作用域分组和菜单更清晰。",
      "向插件开放主机剪贴板历史能力。",
      "让空会话持久保留，重启后可以继续显示和复用。",
      "优化模型选择菜单：供应商层级更清晰，滚动时保持稳定。",
      "Read 工具始终返回文件总行数，可靠地分页读取大文件。",
      "更可靠地在流式恢复与重试中识别限流错误。",
      "从 Files 面板打开文件时，在文件管理器中显示选中的文件。",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-08-20",
    highlights: [
      "让置顶项目在侧边栏中使用不同图标，更容易识别。",
      "修复子代理完成后活动状态仍卡在“运行中”的问题。",
      "让插件页面和面板的界面风格更贴合应用其余部分。",
      "降低输入框打字和发送消息时的延迟。",
      "让长对话滚动更流畅，并避免切换会话时闪烁。",
      "恢复空白首页的说明文字和底部对齐的输入框布局。",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-08-20",
    highlights: [
      "在内置 Files 面板中浏览项目文件，并使用操作系统默认应用打开文件。",
      "为工作面板添加隔离的插件视图，并展示插件市场的来源信息和撤回版本状态。",
      "移除内置交互式终端；Bash 输出仍保留在对话中，交互式 Shell 使用外部终端。",
      "原地重试供应商限流，不产生重复的助手消息；重试额度耗尽后提供“继续”操作。",
      "使用紧凑的上下文摘要，一眼查看模型、工具、缓存和压缩使用情况。",
      "通过输入框中的本地化斜杠命令提示，了解五个核心会话命令。",
      "统一首页与会话输入框的布局，让欢迎语和命令提示平滑轮换。",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-08-19",
    highlights: [
      "支持登录多个供应商账号，并为每个供应商选择实际使用的账号。",
      "根据模型能力决定是否支持图片附件。",
      "在输入框中直接选择支持该功能的模型的推理强度。",
      "每个数据目录只运行一个 PI-Desktop 实例，避免会话冲突。",
      "重新整理设置分组，简化供应商账号管理。",
      "让内置子代理遵循父级对话的权限模式。",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-08-17",
    highlights: [
      "将子代理放到后台委派，并在不阻塞对话的情况下等待结果。",
      "将并行子代理上限提升到 10，并按每个代理的权限范围执行委派任务。",
      "内置探索与修复子代理，覆盖常见的后台任务。",
      "首次关闭窗口时询问是最小化到托盘还是退出，并记住该选择。",
      "让插件面板跟随应用的语言和颜色模式。",
      "在同一轮对话中重试中途遇到的限流错误，而不是直接中断回复。",
      "在 sidecar 中断后恢复已批准的 Plan 执行。",
      "避免 sidecar 崩溃通知破坏已经关闭的窗口。",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-08-15",
    highlights: [
      "将插件文件访问限制在其声明的作用域内，删除的文件会移入废纸篓以便恢复。",
      "在插件权限展示处显示其声明的文件作用域。",
      "将插件网络请求限制在其声明的域名白名单内。",
      "将未知的插件面板通道转发给插件，让更深度的集成保持可用。",
      "修复侧边栏折叠时的闪烁问题。",
      "让代理的编辑操作锚定在明确的行范围内，被中断时能优雅恢复，不再静默结束回合。",
      "统一卡片排版字体层级，界面更加一致。",
      "将桌面壳与代理运行时升级到最新的 Electron 和 pi 版本。",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-08-14",
    highlights: [
      "点击即可打开上下文使用情况检查器，查看 token 和缓存统计。",
      "新增快捷键切换工作面板可见性。",
      "新任务草稿在发送第一条消息前不会保留在历史记录中。",
      "添加自定义全局字体选择器，内置 OFL 字体，支持个性化排版。",
      "在启动器中记住最近使用的插件，加快访问速度。",
      "为开发者模式添加复制会话路径的上下文菜单。",
      "修复字体选择器裁剪和系统默认重置问题。",
      "关闭窗口后保持 macOS PI-Desktop 在 Dock 和 Cmd+Tab 中可见。",
      "发送消息后收起输入框时保持聊天记录停留在最新位置。",
      "为工作面板添加真实的空状态界面和更清晰的引导。",
    ],
  },
  {
    version: "0.5.11",
    date: "2026-08-13",
    highlights: [
      "为插件市场添加离线可用性和元数据刷新功能。",
      "为 composer 添加按对话缓存草稿功能，加快会话恢复速度。",
      "本地化插件面板标题并适配面板窗口框架。",
      "修复深色表面上的吉祥物键颜色。",
      "减少 macOS 启动器快捷键延迟，交互更灵敏。",
    ],
  },
  {
    version: "0.5.10",
    date: "2026-08-13",
    highlights: [
      "优化插件面板窗口控制栏和安全区，避免插件内容被原生控件遮挡。",
      "优化插件页的信息层级并精简概览文案，让扩展工作流更加清晰。",
      "使用正确的 macOS 托盘模板图标，让菜单栏显示更加清晰。",
    ],
  },
  {
    version: "0.5.9",
    date: "2026-08-13",
    highlights: [
      "让 Goal 模式统一使用自动权限处理，工作流更加稳定一致。",
      "预热全局插件启动器以缩短打开时间，即使当前焦点在其他应用也能快速唤起。",
      "为插件面板提供原生窗口控制栏，稳定支持最小化、最大化和关闭操作。",
      "重构双语文档站，补齐英文与简体中文的指南和技术规范。",
    ],
  },
  {
    version: "0.5.8",
    date: "2026-08-12",
    highlights: [
      "修复 Windows 下的 Alt+Space 全局插件启动器，即使当前焦点在其他应用也能唤起。",
      "最小化后可通过系统托盘访问 PI-Desktop，并支持 macOS、Windows 和 Linux。",
      "优化浅色和深色主题下原生选择菜单的可读性。",
    ],
  },
  {
    version: "0.5.7",
    date: "2026-08-12",
    highlights: [
      "新增 asktool 提问能力，支持单选、多选、自定义回答、跳过和拒绝回答。",
      "通过已回答、未回答和已跳过指示器展示多问题进度。",
      "将交互式提问放置在与 Plan 和 Goal 审批相同的 Composer 审批区域。",
      "简化审批确认卡片，并记住下次请求使用的审批模式。",
    ],
  },
  {
    version: "0.5.6",
    date: "2026-08-11",
    highlights: [
      "通过全局键盘启动器打开已安装插件，无需离开当前工作区。",
      "可收起展开的思考、工具和子代理详情，让长对话更易阅读。",
      "任务运行期间仍可调整下一轮配置，并在停止后查看吞吐统计。",
      "优化全局圆角层级，让界面分组更清晰。",
    ],
  },
  {
    version: "0.5.5",
    date: "2026-08-11",
    highlights: [
      "在对话中直接展示并行子代理及其任务关系。",
      "让粘贴的文件引用保持紧凑，并在停止任务后恢复文件标签。",
      "创建会话时保持模式控件可用，发送消息后让对话继续停留在最新位置。",
      "原生工具收到错误文件路径时可更稳妥地恢复。",
      "优化侧边栏底部操作和用户消息中换行链接的排版。",
    ],
  },
  {
    version: "0.5.4",
    date: "2026-08-08",
    highlights: [
      "优化空首页宠物的待机节奏，让动作切换更自然，并在鼠标悬停时连续播放。",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-08-07",
    highlights: [
      "通过 Task 工具运行有界子代理，支持用户自定义代理、固定模型、归属标记与会话持久化。",
      "可在扩展页面管理子代理，支持注册表重载，并提供更清晰的只读状态。",
      "在空闲期间准备并安装上下文检查点，同时保留完整对话历史，并显示压缩行和提醒。",
      "新增作为第二种契约模式的 Goal 模式，并在模式命令后保留粘贴的文件引用。",
      "宿主重新连接后自动恢复子代理及其他宿主面板，并降低例行拆除时的诊断噪声。",
      "优化工作面板与扩展页面的元信息、控件和深色主题对比度。",
    ],
  },
  {
    version: "0.4.3",
    date: "2026-08-05",
    highlights: [
      "完善 Agent-only 规划流程，支持持久化 Markdown 规划、审批与排队执行。",
      "新增项目级 MCP 服务器和 Skill，并用一个扩展作用域控件统一管理。",
      "强化跨工作区的外部路径权限与原生搜索范围控制。",
      "规划审批完成后自动收起审批界面，命令切换可直接更新当前会话模式。",
      "长对话会自动压缩上下文：完整记录始终保留，压缩位置在对话中标记出来，并会提醒你以便决定是否另开会话。",
    ],
  },
  {
    version: "0.4.2",
    date: "2026-08-03",
    highlights: [
      "在聊天记录头部显示上下文缓存命中率，提升透明度。",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-08-02",
    highlights: [
      "将 GitHub Releases 与自动更新链接统一到正式的 PI-Desktop 仓库。",
      "更新项目、插件和发布文档中的仓库名称，统一使用 PI-Desktop。",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-08-01",
    highlights: [
      "插件现可贡献技能、主题、MCP 服务器、常驻服务以及插件间消息总线。",
      "插件 SDK 声明所有新增能力类型，作者可通过清单激活。",
      "宿主核心校验能力贡献并自动派生每插件权限。",
      "智能体系统提示词现包含插件声明的技能，支持工具感知对话。",
      "插件页面重新设计，新增模板选择器、保存时热重载与开发工具。",
      "从模板创建插件后会自动将脚手架文件夹作为项目打开。",
      "统一工作面板头部菜单，控件与上下文操作更清晰。",
      "样式拆分为按表面分文件，清理重复与无用 CSS。",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-31",
    highlights: [
      "设置页项目归档改用分组布局（置顶 / 全部 / 已归档），每组显示计数，并支持实时搜索与排序。",
      "工作面板停靠宽度收窄，布局更协调。",
      "修复浅色主题下开关控件样式异常。",
    ],
  },
  {
    version: "0.2.11",
    date: "2026-07-31",
    highlights: [
      "全局搜索现可同时查找聊天、页面、设置，以及内置和插件命令。",
      "外观设置改用主题与语言预览卡片，自动语言会正确跟随操作系统。",
      "设置页新增独立的“全局 AI”和“快捷键”分区，导航更清晰。",
      "智能体可自动加载分层的 AGENTS.md/CLAUDE.md 项目指令，并支持编辑全局与项目 AGENTS.md。",
      "项目归档支持按会话标题搜索，并按最新活动展示会话数量、更新时间和更多历史。",
      "修复沙箱化预加载回归导致的桌面应用启动故障。",
      "将审计后的 macOS 应用解压体积缩减约 55%，同时保留离线语法高亮与原生终端能力。",
    ],
  },
  {
    version: "0.2.10",
    date: "2026-07-30",
    highlights: [
      "添加 Codex/WorkBuddy 风格对话顶栏，改进控制按钮。",
      "刷新聊天记录和 Markdown 样式，提升可读性。",
      "统一工作面板头部，添加上下文菜单并动画化侧边栏折叠。",
      "合并工具启动器为单个创建下拉菜单，界面更简洁。",
      "工作面板在固定窗口内停靠，不再扩展窗口。",
      "优化顶栏控制：去重切换按钮、保护控件、macOS 对齐。",
    ],
  },
  {
    version: "0.2.8",
    date: "2026-07-29",
    highlights: [
      "更新提示与设置页现可打开完整的本地化发布说明。",
      "工作面板展开与收起动画更加顺滑。",
      "长对话可更可靠地压缩超大工具结果批次。",
    ],
  },
  {
    version: "0.2.7",
    date: "2026-07-28",
    highlights: [
      "助手 Markdown 回复可内联渲染图片、音频与视频。",
      "远程图片可正常显示（内容安全策略已更新）。",
      "媒体标记经消毒过滤，仅允许安全标签。",
    ],
  },
  {
    version: "0.2.6",
    date: "2026-07-28",
    highlights: [
      "在回合边界做上下文检查点压缩，长对话不再隐藏历史。",
      "会话切换更顺畅：缓存最近对话，并保持稳定过渡帧。",
      "停靠工具保持固定宽度，聊天区域在工作面板旁仍可读。",
      "项目菜单可在系统文件管理器中打开项目文件夹。",
      "输入框提示行不再显示品牌图标。",
    ],
  },
  {
    version: "0.2.5",
    date: "2026-07-28",
    highlights: [
      "工作面板导航重做，工具轨更清晰。",
      "窗口缩放感知面板布局，尺寸变化更可预期。",
      "流式渲染隔离，交互更跟手。",
      "具备推理能力的新会话默认使用最高思考级别。",
      "发送后对话列表保持贴在最新消息。",
    ],
  },
  {
    version: "0.2.4",
    date: "2026-07-28",
    highlights: [
      "输入框芯片的下行字母完整可见。",
      "更新 pi-ai，支持包括 Claude Opus 5 在内的新模型。",
    ],
  },
  {
    version: "0.2.3",
    date: "2026-07-28",
    highlights: [
      "界面文案改为更直白的用户语言（含多语言）。",
      "选中态、中文标签与悬停动效打磨。",
      "工作面板与设置页浅色表面细化。",
      "预发布安装现可发现更新的正式版 GitHub Release。",
    ],
  },
  {
    version: "0.2.2",
    date: "2026-07-27",
    highlights: [
      "插件市场支持官方远程目录与详情页。",
      "插件面板隔离，高风险 API 受权限门控。",
      "分区工具栏支持右键新建项目或会话。",
      "启动闪屏、更顺滑动效与 i18n 打磨。",
      "工作面板顶栏支持右键打开工具。",
    ],
  },
  {
    version: "0.2.1",
    date: "2026-07-27",
    highlights: [
      "工作面板工具按会话保留。",
      "“审查更改”入口仅属于产生编辑的那次会话。",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-07-27",
    highlights: [
      "侧边栏区分项目与会话，任务状态更清晰。",
      "可分支或编辑助手回复；消息工具栏改为图标按钮。",
      "文件编辑成功后提供工作区审查入口。",
      "键盘快捷键映射，以及用于 DevTools 的开发者模式。",
      "以 pi 模型目录作为提供商模型的权威来源。",
      "思考级别控件放在输入区模式旁。",
    ],
  },
  {
    version: "0.1.1",
    date: "2026-07-26",
    highlights: [
      "首次公开发布：本地优先的 AI 编程助手桌面客户端。",
      "Chat / Agent 模式，支持流式回复、思考级别与模型管理。",
      "工作区工具含权限确认、终端、浏览器与 Git 审查。",
      "Rust 宿主负责存储、密钥、会话与通知。",
      "插件基础能力，界面支持 English / 简体中文。",
      "可检查 GitHub Releases 更新（支持的平台可应用内更新）。",
    ],
  },
];

/** Locale → newest-first product notes. */
export const CHANGELOG: Record<ChangelogLocale, readonly ChangelogEntry[]> = {
  en: enEntries,
  "zh-CN": zhCNEntries,
};

/** Normalize `v0.2.7` / whitespace to the catalog key form. */
export function normalizeChangelogVersion(
  version: string | null | undefined,
): string {
  return String(version ?? "")
    .trim()
    .replace(/^v/i, "");
}

export function resolveChangelogLocale(
  input?: string | null,
): ChangelogLocale {
  const value = (input || "").toLowerCase();
  if (value.startsWith("zh")) return "zh-CN";
  return "en";
}

export function getChangelogEntry(
  version: string | null | undefined,
  locale: ChangelogLocale = "en",
): ChangelogEntry | undefined {
  const key = normalizeChangelogVersion(version);
  if (!key) return undefined;
  const catalog = CHANGELOG[locale] ?? CHANGELOG.en;
  return catalog.find((entry) => entry.version === key);
}

/**
 * Format highlights as plain multi-line text for UpdateState / compact UI.
 * Returns undefined when the version has no catalog entry or empty highlights.
 */
export function formatChangelogNotes(
  version: string | null | undefined,
  localeInput?: string | null,
): string | undefined {
  const locale = resolveChangelogLocale(localeInput);
  const entry =
    getChangelogEntry(version, locale) ??
    (locale === "en" ? undefined : getChangelogEntry(version, "en"));
  if (!entry?.highlights.length) return undefined;
  return entry.highlights.map((line) => `• ${line}`).join("\n");
}
