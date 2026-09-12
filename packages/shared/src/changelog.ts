import { deEntries } from "./changelog-de.js";
import { esEntries } from "./changelog-es.js";
import { frEntries } from "./changelog-fr.js";
import { koEntries } from "./changelog-ko.js";
import { trEntries } from "./changelog-tr.js";

/**
 * Shipped-locale product changelog for PI-Desktop app releases.
 *
 * English is the source of truth (ADR 0009). The translated catalogs mirror
 * the same versions and bullet counts so in-app "what's new" can follow the
 * active UI locale without a network fetch or renderer-supplied feed URL.
 *
 * Update this file before cutting a release tag. GitHub release bodies may
 * still be auto-generated for the web; they are not the in-app source.
 * Stable product versions only — omit pre-releases.
 */

export type ChangelogLocale = "en" | "zh-CN" | "zh-TW" | "tr" | "de" | "es" | "fr" | "ko";

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
    version: "0.14.6",
    date: "2026-09-10",
    highlights: [
      "Warn when this build is older than your local data, or is the Intel build running on Apple Silicon, instead of failing silently.",
      "Add a local MCP desktop control plane, and let reviewed plugins drive the desktop only after native consent.",
      "Add subagent preset templates, a provider-bounded model picker, and the effective thinking level on delegation cards.",
      "Alias configured models, copy model IDs, and honor a model's own wire API over the provider-wide style.",
      "Replace textual Edit matching with line-anchored operations, with error-specific recovery guidance.",
      "Retry providers up to ten times with a visible countdown, and recover autonomous progress-only turns.",
      "Redesign the macOS installer, add a Windows portable exe and Linux RPM package, and restore GNOME tray and dock icons.",
      "Copy conversation IDs and open session folders from the sidebar, with localized tooltips on icon-only actions.",
      "Show live process status and quiet intervals on the activity row, and add a viewport-fixed work panel toggle.",
      "Enforce workspace ignore rules, resolve dangling symlinks, and re-check plugin network egress on every redirect.",
      "Honor proxy bypass rules, keep pasted private-use glyphs, and load file previews without blocking the composer.",
    ],
  },
  {
    version: "0.14.5",
    date: "2026-09-09",
    highlights: [
      "Label every macOS DMG and ZIP with its native arm64 or x64 architecture.",
    ],
  },
  {
    version: "0.14.4",
    date: "2026-09-09",
    highlights: [
      "Add bounded large-file range reads and gesture-bound dropped-file grants for plugins.",
      "Make macOS signing and notarization explicit opt-in, with opening guidance for trusted unsigned builds.",
    ],
  },
  {
    version: "0.14.3",
    date: "2026-09-09",
    highlights: [
      "Label Intel macOS release downloads explicitly so the installer architecture is clear.",
    ],
  },
  {
    version: "0.14.2",
    date: "2026-09-08",
    highlights: [
      "Add a context usage inspector that follows the selected model and shows compaction guidance.",
      "Improve provider and model setup with searchable selection, bulk actions, and clearer fetch errors.",
      "Summarize session titles automatically and let you rename projects with names that persist across restarts.",
      "Refine the subagent side sheet with live status, compact task bubbles, model identity, and latest-output navigation.",
      "Deliver native notifications for interactive asks and approvals while keeping routine completions out of the inbox.",
      "Add Korean shell localization and improve localized settings, clipboard history, and safe link handling.",
    ],
  },
  {
    version: "0.14.1",
    date: "2026-09-08",
    highlights: [
      "Make subagent delegation inherit the parent model when no delegation model is configured.",
      "Prevent echoed parent model IDs from being rejected as unavailable delegation models.",
    ],
  },
  {
    version: "0.14.0",
    date: "2026-09-08",
    highlights: [
      "Configure outbound HTTP proxies per provider, with validation and clear handling for unsupported SOCKS4 credentials.",
      "Import provider profiles and model configurations from CC Switch and local agent stores.",
      "Add custom provider headers, User-Agent settings, and a MiniMax preset with clearer model-fetch errors.",
      "Attach files from the unified picker with session-scratch copies and inline image support.",
      "Add Traditional Chinese, German, Spanish, and French shell locales, plus searchable appearance and provider settings.",
      "Adjust reading font sizes, typography, and icons consistently, and show the selected subagent model in delegation cards.",
    ],
  },
  {
    version: "0.13.11",
    date: "2026-09-07",
    highlights: [
      "Let plugins list models, read in-flight session context, and request host-owned completions without receiving credentials.",
    ],
  },
  {
    version: "0.13.10",
    date: "2026-09-07",
    highlights: [
      "Confirm before quitting (Cmd+Q, tray, or menu) to prevent accidental data loss.",
    ],
  },
  {
    version: "0.13.9",
    date: "2026-09-06",
    highlights: [
      "Version bump for release infrastructure.",
    ],
  },
  {
    version: "0.13.8",
    date: "2026-09-06",
    highlights: [
      "Search and preview project files, including images, then open them with the default app from a dedicated viewer page.",
      "Run the work-panel Browser as a bundled plugin, with the same isolation as other plugin views.",
      "Keep @ file chips after Enter, and pulse the mode chip while planning.",
      "Open only http(s) and mailto links from chat, plugins, and previews.",
    ],
  },
  {
    version: "0.13.7",
    date: "2026-09-06",
    highlights: [
      "Keep completed AI replies after restart, instead of showing only the user messages.",
      "Keep background subagents running until you stop them or the parent stops them.",
      "Let the agent choose a Bash timeout up to six hours so long jobs are not killed at 60 seconds.",
    ],
  },
  {
    version: "0.13.6",
    date: "2026-09-06",
    highlights: [
      "Keep pasted-file user messages sized to their content instead of stretching across the thread.",
    ],
  },
  {
    version: "0.13.5",
    date: "2026-09-06",
    highlights: [
      "Remove the A2A broker and peer-to-peer conversation tools.",
      "Fix agent-runtime tests that broke after the A2A removal.",
    ],
  },
  {
    version: "0.13.4",
    date: "2026-09-05",
    highlights: [
      "Add Turkish and a searchable language picker in Settings → General.",
      "Make theme a searchable picker like language, including plugin themes.",
      "Flatten the add-provider Service list, add Xiaomi, Zhipu, and Z.AI, and make Service searchable.",
      "Report a problem from Settings → Info with version and OS already filled.",
      "Keep streaming conversation turns in chronological order when the live transcript merges.",
    ],
  },
  {
    version: "0.13.3",
    date: "2026-09-05",
    highlights: [
      "Open New Task to an empty destination immediately, without keeping the previous transcript on screen.",
      "Treat a filled Read window as complete and keep the truncated chip for actual cuts.",
      "Keep later conversation turns when switching regenerate variants, instead of restoring a stale archive.",
    ],
  },
  {
    version: "0.13.2",
    date: "2026-09-05",
    highlights: [
      "Keep unsent composer drafts, including file chips, when the input remounts or the window is hidden.",
      "Start new sessions at the model binding's default thinking level instead of always using the strongest.",
      "Keep expanded subagent runs scrolled to the latest output, with a jump-to-latest control after you scroll up.",
      "Keep the thinking-level menu available when pinning a level while a turn is running.",
      "Keep add-provider fields fully visible and focused in a narrow window.",
      "Match the macOS startup splash to the sidebar glass so the window no longer flashes an opaque panel.",
    ],
  },
  {
    version: "0.13.1",
    date: "2026-09-05",
    highlights: [
      "Insert atomic attachment chips on the composer input line, with a three-line default height.",
      "Checkpoint streaming replies so they survive quit, sidecar loss, and Stop without rewriting the transcript.",
      "Hide successful completions from the notification inbox.",
      "Remove in-flow borders and dividers, and show scrollbars only on hover or while scrolling.",
      "Play light and dark GIF mascots on the empty-home screen.",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-09-04",
    highlights: [
      "Add a rich hover card on sidebar session rows showing workspace, branch, and update time.",
      "Switch macOS sidebar to the under-window vibrancy material for deeper glass depth.",
      "Remove the macOS sidebar dock seam for a borderless glass edge.",
      "Play theme-specific eight-frame waving mascots on the empty-home screen.",
      "Fix a sidebar crash on first render caused by a forward-referenced variable.",
    ],
  },
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
    version: "0.14.6",
    date: "2026-09-10",
    highlights: [
      "当安装的版本比本地数据更旧，或在 Apple Silicon 上运行 Intel 版本时给出明确提示，而不是静默失败。",
      "新增本地 MCP 桌面控制平面，经审核的插件只有在原生确认后才能控制桌面。",
      "新增子智能体预设模板、按服务商限定的模型选择器，并在委派卡片上显示实际思考级别。",
      "可为已配置模型设置别名并复制模型 ID，模型自身的接口协议优先于服务商级设置。",
      "Edit 工具改为按行锚定的操作，取代文本匹配，并提供针对具体错误的恢复指引。",
      "服务商请求最多重试十次并显示倒计时，自主模式下仅有进展的回合也能继续恢复。",
      "重新设计 macOS 安装器，新增 Windows 便携版和 Linux RPM 包，恢复 GNOME 托盘与 Dock 图标。",
      "可从侧边栏复制会话 ID 或打开会话文件夹，仅图标的操作均有本地化提示。",
      "活动行显示实时进程状态与安静间隔，新增固定在视口的工作面板切换按钮。",
      "强制执行工作区忽略规则，解析悬空符号链接，并在每次重定向时重新检查插件网络出口。",
      "遵循代理绕过规则，保留粘贴的私用区字形，文件预览不再阻塞输入区。",
    ],
  },
  {
    version: "0.14.5",
    date: "2026-09-09",
    highlights: [
      "为每个 macOS DMG 和 ZIP 标注原生 arm64 或 x64 架构。",
    ],
  },
  {
    version: "0.14.4",
    date: "2026-09-09",
    highlights: [
      "为插件新增有上限的大文件范围读取和绑定真实拖拽手势的文件授权。",
      "将 macOS 签名和公证改为明确的可选流程，并为可信未签名构建提供打开指引。",
    ],
  },
  {
    version: "0.14.3",
    date: "2026-09-09",
    highlights: [
      "为 Intel macOS 发布下载添加明确后缀，方便区分安装包架构。",
    ],
  },
  {
    version: "0.14.2",
    date: "2026-09-08",
    highlights: [
      "新增上下文用量检查器，跟随当前模型显示上下文窗口和压缩提示。",
      "改进服务商和模型配置，支持可搜索选择、批量操作，并提供更清晰的获取错误提示。",
      "支持自动总结会话标题，并可重命名项目；项目名称会在重启后保留。",
      "优化子智能体侧边面板，显示实时状态、紧凑任务气泡和模型信息，并支持跳转到最新输出。",
      "为交互式提问和审批提供原生通知，同时不再将普通完成消息放入通知收件箱。",
      "新增韩语界面，并改进本地化设置、剪贴板历史和安全链接处理。",    ],
  },
  {
    version: "0.14.1",
    date: "2026-09-08",
    highlights: [
      "未配置委派模型时，让子智能体继承主 Agent 当前使用的模型。",
      "避免主 Agent 回显当前模型 ID 时被误判为不可用的委派模型。",
    ],
  },
  {
    version: "0.14.0",
    date: "2026-09-08",
    highlights: [
      "支持按服务商配置出站 HTTP 代理，校验代理设置，并明确处理不支持的 SOCKS4 凭据。",
      "可从 CC Switch 和本地智能体存储导入服务商配置与模型配置。",
      "支持自定义服务商请求头和 User-Agent，新增 MiniMax 预设，并改进模型获取错误提示。",
      "通过统一文件选择器添加附件，复制到会话临时目录，并支持行内图片。",
      "新增繁体中文、德语、西班牙语和法语界面，并支持搜索外观与服务商设置。",
      "统一调整阅读字号、文字和图标大小，并在委派卡片中显示所选子智能体模型。",
    ],
  },
  {
    version: "0.13.11",
    date: "2026-09-07",
    highlights: [
      "插件可列出模型、读取当前会话，并请求宿主代发补全，不会拿到凭据。",
    ],
  },
  {
    version: "0.13.10",
    date: "2026-09-07",
    highlights: [
      "退出前弹出确认对话框（快捷键、托盘或菜单退出），防止意外丢失数据。",
    ],
  },
  {
    version: "0.13.9",
    date: "2026-09-06",
    highlights: [
      "版本号更新，用于发布基础设施。",
    ],
  },
  {
    version: "0.13.8",
    date: "2026-09-06",
    highlights: [
      "可搜索并预览项目文件（含图片），在独立查看页用默认应用打开。",
      "工作面板浏览器改为随应用打包的插件，隔离方式与其他插件视图相同。",
      "用 Enter 接受的 @ 文件芯片会保留，规划进行中模式芯片会脉冲提示。",
      "聊天、插件和预览只打开 http(s) 与 mailto 链接。",
    ],
  },
  {
    version: "0.13.7",
    date: "2026-09-06",
    highlights: [
      "重启后保留已完成的 AI 回复，不再只显示用户消息。",
      "后台子智能体一直运行到你或父智能体停止它们。",
      "智能体可将 Bash 超时设为最长六小时，长时间任务不会在 60 秒被杀掉。",
    ],
  },
  {
    version: "0.13.6",
    date: "2026-09-06",
    highlights: [
      "粘贴文件后的用户消息按内容宽度显示，不再被撑满整列。",
    ],
  },
  {
    version: "0.13.5",
    date: "2026-09-06",
    highlights: [
      "移除 A2A 代理和对等对话工具。",
      "修复 A2A 移除后智能体运行时测试失败的问题。",
    ],
  },
  {
    version: "0.13.4",
    date: "2026-09-05",
    highlights: [
      "设置 → 常规新增土耳其语，语言改为可搜索选择器。",
      "主题改为与语言相同的可搜索选择器，插件主题也在同一列表中。",
      "添加服务商时服务列表改为平铺可搜索，并加入小米、智谱和 Z.AI。",
      "设置 → 信息可提交问题反馈，并自动带上当前版本和操作系统。",
      "流式转录合并时保持对话回合的时间顺序。",
    ],
  },
  {
    version: "0.13.3",
    date: "2026-09-05",
    highlights: [
      "新建任务会立刻显示空会话，不再在宿主读写期间继续展示上一条转录。",
      "读文件填满窗口时视为完整而非截断，截断标记只用于真正被裁切的结果。",
      "切换重新生成的版本时保留之后的对话回合，不再用过期归档覆盖后续内容。",
    ],
  },
  {
    version: "0.13.2",
    date: "2026-09-05",
    highlights: [
      "输入框重新挂载或窗口隐藏后再打开时，未发送的草稿和附件芯片仍会保留。",
      "新会话使用模型绑定的默认思考级别，而不再总是选最强档。",
      "展开的子智能体运行会跟随最新输出，上翻后可点回到最新。",
      "在回合进行中固定思考级别时，思考菜单仍保持可用。",
      "窄窗口下添加服务商的输入框能完整显示并保持焦点可见。",
      "macOS 启动闪屏与侧边栏使用同一套毛玻璃，避免先闪出不透明面板。",
    ],
  },
  {
    version: "0.13.1",
    date: "2026-09-05",
    highlights: [
      "在输入行插入原子附件芯片，并将默认输入高度设为三行。",
      "对流式回复做检查点，退出、sidecar 断开或点停止时仍保留已生成内容，且不会重写转录。",
      "成功完成的任务不再进入通知收件箱。",
      "去掉界面中的内联边框与分隔线，滚动条仅在悬停或滚动时显示。",
      "首页空状态使用浅色与深色主题的 GIF 吉祥物。",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-09-04",
    highlights: [
      "侧边栏会话行新增悬浮卡片，显示所属空间、分支和更新时间。",
      "macOS 侧边栏切换到窗口下方材质，增强毛玻璃深度。",
      "移除 macOS 侧边栏的底部分隔线，呈现无边框玻璃效果。",
      "首页空状态按浅色/深色主题播放八帧挥手吉祥物动画。",
      "修复侧边栏首次渲染时因变量前向引用导致的崩溃。",
    ],
  },
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

const zhTWEntries: ChangelogEntry[] = [
  {
    version: "0.14.6",
    date: "2026-09-10",
    highlights: [
      "當安裝的版本比本機資料更舊，或在 Apple Silicon 上執行 Intel 版本時給出明確提示，而不是靜默失敗。",
      "新增本機 MCP 桌面控制平面，經審核的外掛只有在原生確認後才能控制桌面。",
      "新增子智慧體預設範本、按服務商限定的模型選擇器，並在委派卡片上顯示實際思考級別。",
      "可為已設定模型設定別名並複製模型 ID，模型自身的介面協定優先於服務商層級設定。",
      "Edit 工具改為按行錨定的操作，取代文字比對，並提供針對具體錯誤的恢復指引。",
      "服務商請求最多重試十次並顯示倒數，自主模式下僅有進展的回合也能繼續恢復。",
      "重新設計 macOS 安裝器，新增 Windows 可攜版和 Linux RPM 套件，恢復 GNOME 系統匣與 Dock 圖示。",
      "可從側邊欄複製會話 ID 或開啟會話資料夾，僅圖示的操作均有本地化提示。",
      "活動列顯示即時程序狀態與安靜間隔，新增固定在視口的工作面板切換按鈕。",
      "強制執行工作區忽略規則，解析懸空符號連結，並在每次重新導向時重新檢查外掛網路出口。",
      "遵循代理略過規則，保留貼上的私用區字形，檔案預覽不再阻塞輸入區。",
    ],
  },
  {
    version: "0.14.5",
    date: "2026-09-09",
    highlights: [
      "為每個 macOS DMG 和 ZIP 標註原生 arm64 或 x64 架構。",
    ],
  },
  {
    version: "0.14.4",
    date: "2026-09-09",
    highlights: [
      "為外掛新增有上限的大型檔案範圍讀取，以及繫結真實拖放手勢的檔案授權。",
      "將 macOS 簽署與公證改為明確的選用流程，並為可信的未簽署版本提供開啟指引。",
    ],
  },
  {
    version: "0.14.3",
    date: "2026-09-09",
    highlights: [
      "為 Intel macOS 發布下載加入明確後綴，方便區分安裝包架構。",
    ],
  },
  {
    version: "0.14.2",
    date: "2026-09-08",
    highlights: [
      "新增上下文用量檢查器，跟隨目前模型顯示上下文視窗和壓縮提示。",
      "改進服務商和模型設定，支援可搜尋選擇、批次操作，並提供更清晰的擷取錯誤提示。",
      "支援自動總結會話標題，並可重新命名專案；專案名稱會在重新啟動後保留。",
      "最佳化子智慧體側邊面板，顯示即時狀態、精簡任務氣泡和模型資訊，並支援跳轉到最新輸出。",
      "為互動式提問和核准提供原生通知，同時不再將一般完成訊息放入通知收件匣。",
      "新增韓語介面，並改進本地化設定、剪貼簿歷史和安全連結處理。",
    ],
  },
  {
    version: "0.14.1",
    date: "2026-09-08",
    highlights: [
      "未設定委派模型時，讓子智慧體繼承主 Agent 目前使用的模型。",
      "避免主 Agent 回傳目前模型 ID 時，被誤判為不可用的委派模型。",
    ],
  },
  {
    version: "0.14.0",
    date: "2026-09-08",
    highlights: [
      "支援按服務商設定對外 HTTP 代理，驗證代理設定，並明確處理不支援的 SOCKS4 憑據。",
      "可從 CC Switch 和本機智慧體儲存匯入服務商設定與模型設定。",
      "支援自訂服務商請求標頭和 User-Agent，新增 MiniMax 預設，並改進模型擷取錯誤提示。",
      "透過統一檔案選擇器新增附件，複製到會話暫存目錄，並支援行內圖片。",
      "新增繁體中文、德語、西班牙語和法語介面，並支援搜尋外觀與服務商設定。",
      "統一調整閱讀字號、文字和圖示大小，並在委派卡片中顯示所選子智慧體模型。",
    ],
  },
  {
    version: "0.13.11",
    date: "2026-09-07",
    highlights: [
      "外掛可列出模型、讀取當前會話，並請求宿主代發補全，不會拿到憑據。",
    ],
  },
  {
    version: "0.13.10",
    date: "2026-09-07",
    highlights: [
      "退出前彈出確認對話方塊（快捷鍵、托盤或選單退出），防止意外丟失資料。",
    ],
  },
  {
    version: "0.13.9",
    date: "2026-09-06",
    highlights: [
      "版本號更新，用於釋出基礎設施。",
    ],
  },
  {
    version: "0.13.8",
    date: "2026-09-06",
    highlights: [
      "可搜尋並預覽專案檔案（含圖片），在獨立檢視頁用預設應用開啟。",
      "工作面板瀏覽器改為隨應用打包的外掛，隔離方式與其他外掛檢視相同。",
      "用 Enter 接受的 @ 檔案晶片會保留，規劃進行中模式晶片會脈衝提示。",
      "聊天、外掛和預覽只打開 http(s) 與 mailto 連結。",
    ],
  },
  {
    version: "0.13.7",
    date: "2026-09-06",
    highlights: [
      "重啟後保留已完成的 AI 回覆，不再只顯示使用者訊息。",
      "後臺子智慧體一直執行到你或父智慧體停止它們。",
      "智慧體可將 Bash 超時設為最長六小時，長時間任務不會在 60 秒被殺掉。",
    ],
  },
  {
    version: "0.13.6",
    date: "2026-09-06",
    highlights: [
      "貼上檔案後的使用者訊息按內容寬度顯示，不再被撐滿整列。",
    ],
  },
  {
    version: "0.13.5",
    date: "2026-09-06",
    highlights: [
      "移除 A2A 代理和對等對話工具。",
      "修復 A2A 移除後智慧體執行時測試失敗的問題。",
    ],
  },
  {
    version: "0.13.4",
    date: "2026-09-05",
    highlights: [
      "設定 → 常規新增土耳其語，語言改為可搜尋選擇器。",
      "主題改為與語言相同的可搜尋選擇器，外掛主題也在同一列表中。",
      "新增服務商時服務列表改為平鋪可搜尋，並加入小米、智譜和 Z.AI。",
      "設定 → 資訊可提交問題反饋，並自動帶上當前版本和作業系統。",
      "流式轉錄合併時保持對話回合的時間順序。",
    ],
  },
  {
    version: "0.13.3",
    date: "2026-09-05",
    highlights: [
      "新建任務會立刻顯示空會話，不再在宿主讀寫期間繼續展示上一條轉錄。",
      "讀檔案填滿視窗時視為完整而非截斷，截斷標記只用於真正被裁切的結果。",
      "切換重新生成的版本時保留之後的對話回合，不再用過期歸檔覆蓋後續內容。",
    ],
  },
  {
    version: "0.13.2",
    date: "2026-09-05",
    highlights: [
      "輸入框重新掛載或視窗隱藏後再開啟時，未傳送的草稿和附件晶片仍會保留。",
      "新會話使用模型繫結的預設思考級別，而不再總是選最強檔。",
      "展開的子智慧體執行會跟隨最新輸出，上翻後可點回到最新。",
      "在回合進行中固定思考級別時，思考選單仍保持可用。",
      "窄視窗下新增服務商的輸入框能完整顯示並保持焦點可見。",
      "macOS 啟動閃屏與側邊欄使用同一套毛玻璃，避免先閃出不透明面板。",
    ],
  },
  {
    version: "0.13.1",
    date: "2026-09-05",
    highlights: [
      "在輸入行插入原子附件晶片，並將預設輸入高度設為三行。",
      "對流式回覆做檢查點，退出、sidecar 斷開或點停止時仍保留已生成內容，且不會重寫轉錄。",
      "成功完成的任務不再進入通知收件箱。",
      "去掉介面中的內聯邊框與分隔線，捲軸僅在懸停或滾動時顯示。",
      "首頁空狀態使用淺色與深色主題的 GIF 吉祥物。",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-09-04",
    highlights: [
      "側邊欄會話行新增懸浮卡片，顯示所屬空間、分支和更新時間。",
      "macOS 側邊欄切換到視窗下方材質，增強毛玻璃深度。",
      "移除 macOS 側邊欄的底部分隔線，呈現無邊框玻璃效果。",
      "首頁空狀態按淺色/深色主題播放八幀揮手吉祥物動畫。",
      "修復側邊欄首次渲染時因變數前向引用導致的崩潰。",
    ],
  },
  {
    version: "0.12.4",
    date: "2026-09-04",
    highlights: [
      "將右側工作面板保留在應用視窗內部，讓 MainChat 像左側邊欄一樣重新分配空間。",
      "支援通過內部拖拽條或鍵盤調整工作面板寬度，同時保持視窗邊界不變。",
      "會話切換時去重分頁轉錄讀取，讓導航更流暢。",
      "為 macOS 增加原生側邊欄表面效果，不改變側邊欄佈局邏輯。",
    ],
  },
  {
    version: "0.12.3",
    date: "2026-09-03",
    highlights: [
      "根據當前選定模型釋出的上下文視窗顯示準確的上下文用量。",
      "在服務商設定、編輯器和執行時之間保持模型級上下文限制一致。",
      "切換模型和進行中的回合時，保持編輯器上下文提示穩定。",
    ],
  },
  {
    version: "0.12.2",
    date: "2026-09-03",
    highlights: [
      "修復使用者訊息行在宿主往返完成前出現的問題。",
      "傳送前清空草稿提示以防止內容殘留。",
      "長對話記錄在骨架遮罩下結算以獲得更流暢的渲染效果。",
    ],
  },
  {
    version: "0.12.1",
    date: "2026-09-03",
    highlights: [
      "儲存服務商設定並重啟應用後，仍可使用已啟用的子智慧體委派模型。",
      "重新開啟會話時繼續顯示正在生成的回覆。",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-09-02",
    highlights: [
      "讓併發子智慧體通過 Agent2Agent（A2A）協議協作：以 Agent Card 發現正在執行的同伴，交換可持久化的任務與型別化訊息，並流式接收任務更新——取代原先的程序內同伴訊息。",
    ],
  },
  {
    version: "0.11.4",
    date: "2026-09-01",
    highlights: [
      "新增原生 macOS Intel DMG 與 ZIP 安裝包，並與 Apple Silicon 版本同時釋出。",
      "統一兩種原生架構的 macOS 更新源，應用內更新發現保持一致。",
    ],
  },
  {
    version: "0.11.3",
    date: "2026-08-31",
    highlights: [
      "為每個子智慧體從委派目錄中分配獨立模型，或讓它繼承父會話的選擇。",
      "讓併發子智慧體通過主題篩選的執行緒化同伴訊息互相通訊。",
      "執行結構化圓桌討論，多個子智慧體圍繞一個話題跨輪次辯論並總結結果。",
      "統一模型配置控制元件——委派核取方塊、自定義模型區塊和字型大小——跨面板保持一致。",
      "用更清晰的圖示提示替代委派提示文字。",
    ],
  },
  {
    version: "0.11.2",
    date: "2026-08-31",
    highlights: [
      "在最近的會話之間切換不再閃屏：每個會話保留自己的面板，回來時與離開時完全一致，滾動位置也保留。",
      "回到之前上翻過的會話會停在原來的位置，而首次開啟的會話仍然定位到最新一輪。",
      "新會話載入期間可以繼續閱讀當前會話，不再看到轉錄變暗。",
      "即使沒有改動文本，也能重試已編輯的提示。",
      "自動上下文壓縮後繼續處理當前任務，而不是讓智慧體撿起更早的請求。",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-08-30",
    highlights: [
      "通過單一的自動發現表單配置服務商：優先向 AI 服務索取其自有模型列表，失敗時回退到內建目錄。",
      "在可搜尋的模型列表中選擇模型，直接檢視來自 models.dev 目錄的能力標籤與上下文長度。",
      "為每個模型繫結單獨覆蓋附件能力與預設思考級別，並且只顯示該模型實際公開的思考級別。",
      "單個子智慧體委派以獨立卡片呈現並展示生命週期行，展開的委派執行內部滾動而不再拉長轉錄。",
      "歷史仍在載入時也能訪問會話大綱，會話列表載入過程中顯示骨架屏而不是空列表。",
      "向輸入框貼上大段文本時自動轉存為會話檔案，同時保持輸入不觸發重排。",
      "跨顯示器拖拽視窗後保留放下的位置，macOS 目標頁面繼續保留標題欄區域。",
      "檔案與搜尋工具呼叫被拒、以及命令超時按毫秒給出時，不再白費一個回合。",
    ],
  },
  {
    version: "0.10.9",
    date: "2026-08-28",
    highlights: [
      "在設定中通過統一的能力工作臺管理技能、子智慧體與 MCP 服務，支援層級篩選、搜尋與二次確認刪除。",
      "讓能力工作臺與設定頂欄在淺色和深色主題下都清晰一致，工具欄與空狀態控制元件尺寸正確。",
      "長會話在滾動、切換會話與懸停縮圖時保持流暢，轉錄內容不再跳動。",
      "完整載入舊版本寫入的轉錄行，歷史會話不再顯示為空。",
      "重新生成或編輯重發時按所選訊息截斷轉錄，並確保分叉會話始終出現在側邊欄中。",
      "以任意響應判斷子智慧體是否存活，為每個內建子智慧體設定回合上限，等待超時報告為仍在執行而非失敗。",
      "服務商請求出現臨時失敗時，按 1/2/4/8 秒等待重試最多四次並共用同一回合預算，流式過程中報告真實的重試次數。",
    ],
  },
  {
    version: "0.10.8",
    date: "2026-08-26",
    highlights: [
      "讓無邊框視窗中的 Windows 原生控制元件與面板操作保持隔離。",
      "為臨時會話提供相互隔離的臨時工作區，避免檔案與專案工作混在一起。",
      "在命令啟動器中恢復提示增強功能，並使用更清晰的機器人模型圖示。",
      "側邊欄捲軸僅在懸停時顯示，同時在靜止時保持低調。",
    ],
  },
  {
    version: "0.10.7",
    date: "2026-08-25",
    highlights: [
      "讓輸入框的傳送和停止控制元件保持在同一穩定位置，確保草稿與執行中的回合始終對齊。",
      "通過命令啟動器繼續使用提示增強功能，不再顯示獨立的工具欄圖示。",
      "讓側邊欄捲軸在靜止時更低調，同時在導航時保持易於發現。",
    ],
  },
  {
    version: "0.10.6",
    date: "2026-08-25",
    highlights: [
      "根據輸入框中精確選中的模型顯示 Thinking 能力，即使新會話尚未建立也能立即生效。",
      "新會話會以所選推理模型釋出的最高強度開始。",
    ],
  },
  {
    version: "0.10.5",
    date: "2026-08-25",
    highlights: [
      "讓無邊框視窗中的 Windows 控制元件與面板操作保持隔離。",
      "可靠開啟 Windows 專案資料夾和檔案，包括帶擴充套件長度字首的路徑。",
      "編輯 CRLF 檔案時保持原有換行風格不變。",
    ],
  },
  {
    version: "0.10.4",
    date: "2026-08-25",
    highlights: [
      "對話模型選擇器只顯示已配置的供應商模型，發現不可用時仍保留已儲存的模型。",
      "為無邊框視窗控制區繪製不透明背景，避免頁面內容穿透原生控制元件區域。",
      "開啟工作面板時保持聊天寬度穩定，收起後恢復僅聊天視窗邊界。",
    ],
  },
  {
    version: "0.10.3",
    date: "2026-08-25",
    highlights: [
      "最佳化一次性提示增強功能，保留當前草稿和檔案引用。",
      "讓輸入框的傳送和停止操作始終與當前草稿及執行中的會話保持一致。",
      "跨 TaskWait 輪次和渲染器重新載入繼續保留後臺代理的關聯資訊。",
      "分支會話建立後立即保留其歷史記錄和對話內容。",
    ],
  },
  {
    version: "0.10.2",
    date: "2026-08-24",
    highlights: [
      "收起側邊欄時，讓聊天內容和輸入框保持舒適的居中寬度。",
      "準備大尺寸圖片附件時無需將整個檔案載入記憶體，重新載入歷史記錄時同樣適用。",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-08-24",
    highlights: [
      "任務執行期間傳送的訊息會按順序排隊，不會丟失當前草稿。",
      "為後臺子代理增加空閒和總時長超時限制，並明確顯示代理超時狀態。",
      "長會話歷史改用分頁載入，向上滾動時按需獲取更早的訊息。",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-08-21",
    highlights: [
      "支援為每個供應商配置多個模型，並在輸入框中直接切換。",
      "在重新設計的設定工作室中管理代理能力，作用域分組和選單更清晰。",
      "向外掛開放主機剪貼簿歷史能力。",
      "讓空會話持久保留，重啟後可以繼續顯示和複用。",
      "最佳化模型選擇選單：供應商層級更清晰，滾動時保持穩定。",
      "Read 工具始終返回檔案總行數，可靠地分頁讀取大檔案。",
      "更可靠地在流式恢復與重試中識別限流錯誤。",
      "從 Files 面板開啟檔案時，在檔案管理器中顯示選中的檔案。",
    ],
  },
  {
    version: "0.9.1",
    date: "2026-08-20",
    highlights: [
      "讓置頂專案在側邊欄中使用不同圖示，更容易識別。",
      "修復子代理完成後活動狀態仍卡在“執行中”的問題。",
      "讓外掛頁面和麵板的介面風格更貼合應用其餘部分。",
      "降低輸入框打字和傳送訊息時的延遲。",
      "讓長對話滾動更流暢，並避免切換會話時閃爍。",
      "恢復空白首頁的說明文字和底部對齊的輸入框佈局。",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-08-20",
    highlights: [
      "在內建 Files 面板中瀏覽專案檔案，並使用作業系統預設應用開啟檔案。",
      "為工作面板新增隔離的外掛檢視，並展示外掛市場的來源資訊和撤回版本狀態。",
      "移除內建互動式終端；Bash 輸出仍保留在對話中，互動式 Shell 使用外部終端。",
      "原地重試供應商限流，不產生重複的助手訊息；重試額度耗盡後提供“繼續”操作。",
      "使用緊湊的上下文摘要，一眼檢視模型、工具、快取和壓縮使用情況。",
      "通過輸入框中的本地化斜槓命令提示，瞭解五個核心會話命令。",
      "統一首頁與會話輸入框的佈局，讓歡迎語和命令提示平滑輪換。",
    ],
  },
  {
    version: "0.8.1",
    date: "2026-08-19",
    highlights: [
      "支援登入多個供應商賬號，併為每個供應商選擇實際使用的賬號。",
      "根據模型能力決定是否支援圖片附件。",
      "在輸入框中直接選擇支援該功能的模型的推理強度。",
      "每個資料目錄只執行一個 PI-Desktop 例項，避免會話衝突。",
      "重新整理設定分組，簡化供應商賬號管理。",
      "讓內建子代理遵循父級對話的許可權模式。",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-08-17",
    highlights: [
      "將子代理放到後臺委派，並在不阻塞對話的情況下等待結果。",
      "將並行子代理上限提升到 10，並按每個代理的許可權範圍執行委派任務。",
      "內建探索與修復子代理，覆蓋常見的後臺任務。",
      "首次關閉視窗時詢問是最小化到托盤還是退出，並記住該選擇。",
      "讓外掛面板跟隨應用的語言和顏色模式。",
      "在同一輪對話中重試中途遇到的限流錯誤，而不是直接中斷回覆。",
      "在 sidecar 中斷後恢復已批准的 Plan 執行。",
      "避免 sidecar 崩潰通知破壞已經關閉的視窗。",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-08-15",
    highlights: [
      "將外掛檔案訪問限制在其宣告的作用域內，刪除的檔案會移入廢紙簍以便恢復。",
      "在外掛許可權展示處顯示其宣告的檔案作用域。",
      "將外掛網路請求限制在其宣告的域名白名單內。",
      "將未知的外掛面板通道轉發給外掛，讓更深度的整合保持可用。",
      "修復側邊欄摺疊時的閃爍問題。",
      "讓代理的編輯操作錨定在明確的行範圍內，被中斷時能優雅恢復，不再靜默結束回合。",
      "統一卡片排版字型層級，介面更加一致。",
      "將桌面殼與代理執行時升級到最新的 Electron 和 pi 版本。",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-08-14",
    highlights: [
      "點選即可開啟上下文使用情況檢查器，檢視 token 和快取統計。",
      "新增快捷鍵切換工作面板可見性。",
      "新任務草稿在傳送第一條訊息前不會保留在歷史記錄中。",
      "新增自定義全域性字型選擇器，內建 OFL 字型，支援個性化排版。",
      "在啟動器中記住最近使用的外掛，加快訪問速度。",
      "為開發者模式新增複製會話路徑的上下文選單。",
      "修復字型選擇器裁剪和系統預設重置問題。",
      "關閉視窗後保持 macOS PI-Desktop 在 Dock 和 Cmd+Tab 中可見。",
      "傳送訊息後收起輸入框時保持聊天記錄停留在最新位置。",
      "為工作面板新增真實的空狀態介面和更清晰的引導。",
    ],
  },
  {
    version: "0.5.11",
    date: "2026-08-13",
    highlights: [
      "為外掛市場新增離線可用性和後設資料重新整理功能。",
      "為 composer 新增按對話快取草稿功能，加快會話恢復速度。",
      "本地化外掛面板標題並適配面板視窗框架。",
      "修復深色表面上的吉祥物鍵顏色。",
      "減少 macOS 啟動器快捷鍵延遲，互動更靈敏。",
    ],
  },
  {
    version: "0.5.10",
    date: "2026-08-13",
    highlights: [
      "最佳化外掛面板視窗控制欄和安全區，避免外掛內容被原生控制元件遮擋。",
      "最佳化外掛頁的資訊層級並精簡概覽文案，讓擴充套件工作流更加清晰。",
      "使用正確的 macOS 托盤模板圖示，讓選單欄顯示更加清晰。",
    ],
  },
  {
    version: "0.5.9",
    date: "2026-08-13",
    highlights: [
      "讓 Goal 模式統一使用自動許可權處理，工作流更加穩定一致。",
      "預熱全域性外掛啟動器以縮短開啟時間，即使當前焦點在其他應用也能快速喚起。",
      "為外掛面板提供原生視窗控制欄，穩定支援最小化、最大化和關閉操作。",
      "重構雙語文件站，補齊英文與簡體中文的指南和技術規範。",
    ],
  },
  {
    version: "0.5.8",
    date: "2026-08-12",
    highlights: [
      "修復 Windows 下的 Alt+Space 全域性外掛啟動器，即使當前焦點在其他應用也能喚起。",
      "最小化後可通過系統托盤訪問 PI-Desktop，並支援 macOS、Windows 和 Linux。",
      "最佳化淺色和深色主題下原生選擇選單的可讀性。",
    ],
  },
  {
    version: "0.5.7",
    date: "2026-08-12",
    highlights: [
      "新增 asktool 提問能力，支援單選、多選、自定義回答、跳過和拒絕回答。",
      "通過已回答、未回答和已跳過指示器展示多問題進度。",
      "將互動式提問放置在與 Plan 和 Goal 審批相同的 Composer 審批區域。",
      "簡化審批確認卡片，並記住下次請求使用的審批模式。",
    ],
  },
  {
    version: "0.5.6",
    date: "2026-08-11",
    highlights: [
      "通過全域性鍵盤啟動器開啟已安裝外掛，無需離開當前工作區。",
      "可收起展開的思考、工具和子代理詳情，讓長對話更易閱讀。",
      "任務執行期間仍可調整下一輪配置，並在停止後檢視吞吐統計。",
      "最佳化全域性圓角層級，讓介面分組更清晰。",
    ],
  },
  {
    version: "0.5.5",
    date: "2026-08-11",
    highlights: [
      "在對話中直接展示並行子代理及其任務關係。",
      "讓貼上的檔案引用保持緊湊，並在停止任務後恢復檔案標籤。",
      "建立會話時保持模式控制元件可用，傳送訊息後讓對話繼續停留在最新位置。",
      "原生工具收到錯誤檔案路徑時可更穩妥地恢復。",
      "最佳化側邊欄底部操作和使用者訊息中換行連結的排版。",
    ],
  },
  {
    version: "0.5.4",
    date: "2026-08-08",
    highlights: [
      "最佳化空首頁寵物的待機節奏，讓動作切換更自然，並在滑鼠懸停時連續播放。",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-08-07",
    highlights: [
      "通過 Task 工具執行有界子代理，支援使用者自定義代理、固定模型、歸屬標記與會話持久化。",
      "可在擴充套件頁面管理子代理，支援登錄檔過載，並提供更清晰的只讀狀態。",
      "在空閒期間準備並安裝上下文檢查點，同時保留完整對話歷史，並顯示壓縮行和提醒。",
      "新增作為第二種契約模式的 Goal 模式，並在模式命令後保留貼上的檔案引用。",
      "宿主重新連線後自動恢復子代理及其他宿主面板，並降低例行拆除時的診斷噪聲。",
      "最佳化工作面板與擴充套件頁面的元資訊、控制元件和深色主題對比度。",
    ],
  },
  {
    version: "0.4.3",
    date: "2026-08-05",
    highlights: [
      "完善 Agent-only 規劃流程，支援持久化 Markdown 規劃、審批與排隊執行。",
      "新增專案級 MCP 伺服器和 Skill，並用一個擴充套件作用域控制元件統一管理。",
      "強化跨工作區的外部路徑許可權與原生搜尋範圍控制。",
      "規劃審批完成後自動收起審批介面，命令切換可直接更新當前會話模式。",
      "長對話會自動壓縮上下文：完整記錄始終保留，壓縮位置在對話中標記出來，並會提醒你以便決定是否另開會話。",
    ],
  },
  {
    version: "0.4.2",
    date: "2026-08-03",
    highlights: [
      "在聊天記錄頭部顯示上下文快取命中率，提升透明度。",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-08-02",
    highlights: [
      "將 GitHub Releases 與自動更新連結統一到正式的 PI-Desktop 倉庫。",
      "更新專案、外掛和釋出文件中的倉庫名稱，統一使用 PI-Desktop。",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-08-01",
    highlights: [
      "外掛現可貢獻技能、主題、MCP 伺服器、常駐服務以及外掛間訊息匯流排。",
      "外掛 SDK 宣告所有新增能力型別，作者可通過清單啟用。",
      "宿主核心校驗能力貢獻並自動派生每外掛許可權。",
      "智慧體系統提示詞現包含外掛宣告的技能，支援工具感知對話。",
      "外掛頁面重新設計，新增模板選擇器、儲存時熱過載與開發工具。",
      "從模板建立外掛後會自動將腳手架資料夾作為專案開啟。",
      "統一工作面板頭部選單，控制元件與上下文操作更清晰。",
      "樣式拆分為按表面分檔案，清理重複與無用 CSS。",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-31",
    highlights: [
      "設定頁專案歸檔改用分組佈局（置頂 / 全部 / 已歸檔），每組顯示計數，並支援即時搜尋與排序。",
      "工作面板停靠寬度收窄，佈局更協調。",
      "修復淺色主題下開關控制元件樣式異常。",
    ],
  },
  {
    version: "0.2.11",
    date: "2026-07-31",
    highlights: [
      "全域性搜尋現可同時查詢聊天、頁面、設定，以及內建和外掛命令。",
      "外觀設定改用主題與語言預覽卡片，自動語言會正確跟隨作業系統。",
      "設定頁新增獨立的“全域性 AI”和“快捷鍵”分割槽，導航更清晰。",
      "智慧體可自動載入分層的 AGENTS.md/CLAUDE.md 專案指令，並支援編輯全域性與專案 AGENTS.md。",
      "專案歸檔支援按會話標題搜尋，並按最新活動展示會話數量、更新時間和更多歷史。",
      "修復沙箱化預載入迴歸導致的桌面應用啟動故障。",
      "將審計後的 macOS 應用解壓體積縮減約 55%，同時保留離線語法高亮與原生終端能力。",
    ],
  },
  {
    version: "0.2.10",
    date: "2026-07-30",
    highlights: [
      "新增 Codex/WorkBuddy 風格對話頂欄，改進控制按鈕。",
      "重新整理聊天記錄和 Markdown 樣式，提升可讀性。",
      "統一工作面板頭部，新增上下文選單並動畫化側邊欄摺疊。",
      "合併工具啟動器為單個建立下拉選單，介面更簡潔。",
      "工作面板在固定視窗內停靠，不再擴充套件視窗。",
      "最佳化頂欄控制：去重切換按鈕、保護控制元件、macOS 對齊。",
    ],
  },
  {
    version: "0.2.8",
    date: "2026-07-29",
    highlights: [
      "更新提示與設定頁現可開啟完整的本地化釋出說明。",
      "工作面板展開與收起動畫更加順滑。",
      "長對話可更可靠地壓縮超大工具結果批次。",
    ],
  },
  {
    version: "0.2.7",
    date: "2026-07-28",
    highlights: [
      "助手 Markdown 回覆可內聯渲染圖片、音訊與影片。",
      "遠端圖片可正常顯示（內容安全策略已更新）。",
      "媒體標記經消毒過濾，僅允許安全標籤。",
    ],
  },
  {
    version: "0.2.6",
    date: "2026-07-28",
    highlights: [
      "在回合邊界做上下文檢查點壓縮，長對話不再隱藏曆史。",
      "會話切換更順暢：快取最近對話，並保持穩定過渡幀。",
      "停靠工具保持固定寬度，聊天區域在工作面板旁仍可讀。",
      "專案選單可在系統檔案管理器中開啟專案資料夾。",
      "輸入框提示行不再顯示品牌圖示。",
    ],
  },
  {
    version: "0.2.5",
    date: "2026-07-28",
    highlights: [
      "工作面板導航重做，工具軌更清晰。",
      "視窗縮放感知面板佈局，尺寸變化更可預期。",
      "流式渲染隔離，互動更跟手。",
      "具備推理能力的新會話預設使用最高思考級別。",
      "傳送後對話列表保持貼在最新訊息。",
    ],
  },
  {
    version: "0.2.4",
    date: "2026-07-28",
    highlights: [
      "輸入框晶片的下行字母完整可見。",
      "更新 pi-ai，支援包括 Claude Opus 5 在內的新模型。",
    ],
  },
  {
    version: "0.2.3",
    date: "2026-07-28",
    highlights: [
      "介面文案改為更直白的使用者語言（含多語言）。",
      "選中態、中文標籤與懸停動效打磨。",
      "工作面板與設定頁淺色表面細化。",
      "預釋出安裝現可發現更新的正式版 GitHub Release。",
    ],
  },
  {
    version: "0.2.2",
    date: "2026-07-27",
    highlights: [
      "外掛市場支援官方遠端目錄與詳情頁。",
      "外掛面板隔離，高風險 API 受許可權門控。",
      "分割槽工具欄支援右鍵新建專案或會話。",
      "啟動閃屏、更順滑動效與 i18n 打磨。",
      "工作面板頂欄支援右鍵開啟工具。",
    ],
  },
  {
    version: "0.2.1",
    date: "2026-07-27",
    highlights: [
      "工作面板工具按會話保留。",
      "“審查更改”入口僅屬於產生編輯的那次會話。",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-07-27",
    highlights: [
      "側邊欄區分專案與會話，任務狀態更清晰。",
      "可分支或編輯助手回覆；訊息工具欄改為圖示按鈕。",
      "檔案編輯成功後提供工作區審查入口。",
      "鍵盤快捷鍵對映，以及用於 DevTools 的開發者模式。",
      "以 pi 模型目錄作為提供商模型的權威來源。",
      "思考級別控制元件放在輸入區模式旁。",
    ],
  },
  {
    version: "0.1.1",
    date: "2026-07-26",
    highlights: [
      "首次公開發布：本地優先的 AI 程式設計助手桌面客戶端。",
      "Chat / Agent 模式，支援流式回覆、思考級別與模型管理。",
      "工作區工具含許可權確認、終端、瀏覽器與 Git 審查。",
      "Rust 宿主負責儲存、金鑰、會話與通知。",
      "外掛基礎能力，介面支援 English / 簡體中文。",
      "可檢查 GitHub Releases 更新（支援的平臺可應用內更新）。",
    ],
  },
];

/** Locale → newest-first product notes. */
export const CHANGELOG: Record<ChangelogLocale, readonly ChangelogEntry[]> = {
  en: enEntries,
  "zh-CN": zhCNEntries,
  "zh-TW": zhTWEntries,
  tr: trEntries,
  de: deEntries,
  es: esEntries,
  fr: frEntries,
  ko: koEntries,
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
  const value = (input || "").replaceAll("_", "-").toLowerCase();
  if (
    value === "zh-tw" ||
    value.startsWith("zh-tw-") ||
    value === "zh-hant" ||
    value.startsWith("zh-hant-") ||
    value === "zh-hk" ||
    value.startsWith("zh-hk-") ||
    value === "zh-mo" ||
    value.startsWith("zh-mo-")
  ) {
    return "zh-TW";
  }
  if (value.startsWith("zh")) return "zh-CN";
  if (value === "tr" || value.startsWith("tr-")) return "tr";
  if (value === "de" || value.startsWith("de-")) return "de";
  if (value === "es" || value.startsWith("es-")) return "es";
  if (value === "fr" || value.startsWith("fr-")) return "fr";
  if (value === "ko" || value.startsWith("ko-")) return "ko";
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
