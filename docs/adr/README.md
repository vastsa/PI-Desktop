# Architecture Decision Records

ADRs record decisions that should not silently change.

The [Chinese ADR entry](/zh-CN/adr/) follows the same decision map and points to
these records. Decision IDs, status, and the English record remain the source of
truth for both locales.

## Format

Each ADR includes:

- Status
- Context
- Decision
- Consequences
- Alternatives (optional)

## Index

| ID | Title | Status |
|---|---|---|
| 0001 | Use Electron as the desktop shell | Accepted |
| 0002 | Use the pi Agent Harness as the kernel | Accepted |
| 0003 | Hybrid runtime — Rust host core + Node pi agent sidecar | Superseded in part |
| 0004 | No remote Gateway in the MVP | Accepted |
| 0005 | User-installable plugin system | Accepted |
| 0006 | Postpone the plugin marketplace; build the local plugin runtime first | Accepted |
| 0007 | Plugin distribution package format uses .piplug (zip) | Accepted |
| 0008 | Plugin runtime targets isolation in a separate process | Accepted (Target) |
| 0009 | English-first globalization | Accepted |
| 0010 | Use Rust as backend host core | Accepted |
| 0011 | Freeze host RPC, storage ownership, and mode defaults | Accepted |
| 0012 | Universal provider/model coverage via pi-ai + OpenAI-compatible extensibility | Accepted |
| 0013 | Consolidate settings navigation into four destinations | Superseded in part by 0026 |
| 0014 | Adopt host-owned storage schema v2 | Accepted |
| 0015 | Make settings content responsive to window width | Accepted |
| 0016 | Organize the sidebar around retained multi-project tabs | Accepted |
| 0017 | Remove composer workspace context rail | Accepted |
| 0018 | Carry thinking mode through the complete session pipeline | Accepted |
| 0019 | Work panel subsystems (embedded browser, git review, file browsing) | Superseded in part by 0108 |
| 0020 | Configuration provider studio | Accepted |
| 0021 | Platform application chrome | Superseded in part by 0025 |
| 0022 | Application Update Delivery | Accepted |
| 0023 | Independent Conversation Session Fork | Accepted |
| 0024 | Composer Slash Commands and @ File References | Accepted |
| 0025 | Keep Application Menus out of Windows/Linux Windows | Accepted |
| 0026 | Move the Projects Index into Settings as an Archive | Superseded in part by 0036 |
| 0027 | Make pi-ai authoritative for model metadata | Accepted |
| 0028 | Scope work-panel runtime contexts to conversations | Accepted |
| 0029 | Separate native-window and work-panel resize ownership | Superseded in part by 0032 |
| 0030 | Turn-boundary context checkpoint compaction | Accepted |
| 0031 | Keep composer prompt rows free of brand icons | Accepted |
| 0032 | Reserve native width for the docked work panel | Accepted (amended by 0033 and 0122) |
| 0033 | Internal-dock work panel (no native window expansion) | Superseded by 0122 |
| 0034 | Merge the command palette into global search | Accepted |
| 0035 | Surface the OS locale through the preload bridge | Accepted |
| 0036 | Split Settings into AI and Shortcuts destinations | Accepted |
| 0037 | Resolve project instructions in Electron main | Accepted |
| 0038 | Bridge plugin-declared MCP servers in Electron main | Accepted |
| 0039 | Activate plugin skills and ship plugin authoring as a first-party devkit | Accepted (skill delivery revised by D174) |
| 0040 | Resident plugin services and the inter-plugin message bus | Accepted |
| 0041 | Bound host runtime resources and decouple message persistence | Accepted |
| 0042 | Message-scoped inline review cards | Superseded by 0043 |
| 0043 | Message-owned review snapshots and guarded rollback | Accepted |
| 0044 | Session-bound project instruction preflight | Accepted |
| 0045 | Bash tool inherits the user's login-shell PATH | Accepted |
| 0046 | Categorized process log files | Accepted |
| 0047 | Context usage inspector with exact and estimated token sources | Accepted |
| 0048 | Lazy per-turn tool activation | Accepted |
| 0049 | Recover automatic context compaction failures with a retained tail | Accepted |
| 0050 | Bounded provider stream recovery and diagnostics | Accepted |
| 0051 | Isolate host RPC stdio from the Tokio blocking pool | Accepted |
| 0052 | Plan operating state and approval boundary | Superseded by 0053 |
| 0053 | Plan checkpoint artifact, approval, and execution epoch | Accepted for implementation |
| 0054 | Selectable command shell catalog and execution identity | Accepted for implementation |
| 0055 | Agent-only mode; Chat becomes an internal read-only profile | Superseded by 0052 / 0053 |
| 0056 | User-owned MCP servers and skills, with a shared activation scope | Accepted |
| 0057 | Permission-gated external paths and portable native search | Accepted for implementation |
| 0058 | Extensions Page Density and Theme-Readable Button Surfaces | Accepted |
| 0059 | Persist Composer Clipboard Files in Session Scratch | Accepted |
| 0060 | Archive the Regenerate Branch Under the RPC Lock | Accepted |
| 0061 | Imperceptible background context compaction | Accepted (amends 0030 / 0049; clauses 2/4/6/7/8 amended by 0064) |
| 0062 | Bounded Subagents Behind a Task Tool | Accepted for implementation |
| 0063 | A Managed Surface for Global Subagent Definitions | Accepted for implementation |
| 0064 | Codex-parity context compaction | Accepted (amends 0061 / 0030) |
| 0065 | Smooth shell layout and stream feedback | Accepted for implementation |
| 0066 | Empty home direct bottom composer | Accepted for implementation (amends D111) |
| 0067 | ChatGPT-inspired empty-home starter guidance | Superseded by D206 |
| 0068 | Add a keyboard entry point for the work panel | Accepted for implementation |
| 0069 | Make native-tool path mistakes recoverable | Accepted for implementation |
| 0070 | Separate Composer File-Reference Display from Prompt Serialization | Accepted for implementation |
| 0071 | Adopt an Apple-Inspired Global Corner Hierarchy | Accepted for implementation |
| 0072 | Add a global plugin launcher | Accepted for implementation |
| 0073 | Stage next-turn composer configuration and preserve stopped throughput | Accepted for implementation |
| 0074 | Native notification permission for plugins | Accepted |
| 0075 | Manual reload for development-plugin permission ceilings | Accepted |
| 0076 | Capture the Windows-reserved plugin launcher chord in host-core | Accepted |
| 0077 | Add an interactive multi-question asktool | Accepted for implementation |
| 0078 | Cross-platform tray-resident minimize | Accepted for implementation (amended by 0117 and 0123) |
| 0079 | Use VitePress for the bilingual documentation site | Accepted |
| 0080 | Prewarm the global plugin launcher after boot | Accepted |
| 0081 | Host-owned cross-platform plugin panel chrome | Accepted |
| 0082 | Localized and page-adaptive plugin panel chrome | Accepted |
| 0083 | Custom global UI font | Accepted |
| 0084 | Defer new-task session creation until the first message | Accepted |
| 0085 | Make the work panel shortcut a toggle | Accepted (amends 0068) |
| 0086 | Keep macOS on the regular activation policy | Accepted |
| 0087 | Replace textual Edit matching with a line-anchored, tag-verified contract | Accepted for implementation (amends 0043 / 0069) |
| 0088 | Plugin file access is declared per mode, and deletion is recoverable | Accepted (continues 0008 D009) |
| 0089 | Proactive Background Subagent Delegation | Accepted for implementation |
| 0090 | User-Configurable Close Behavior with Close-to-Tray | Accepted for implementation |
| 0091 | Route provider rate limits through bounded same-turn retry | Accepted (amends 0050) |
| 0092 | Use a plugin-owned surface with a host window-control capsule | Accepted |
| 0093 | Keep a strict 46px plugin drag band with a minimal capsule | Accepted |
| 0094 | Admit one desktop instance per data directory | Accepted |
| 0095 | Sign in with a vendor account instead of pasting an API key | Accepted for implementation |
| 0096 | Flatten the Settings directory and colocate marketplace source configuration | Accepted |
| 0097 | Place global defaults under the AI settings destination | Accepted |
| 0098 | Treat every vendor OAuth account as an independent provider row | Accepted for implementation |
| 0099 | Add titled visual clusters to the Settings directory | Accepted |
| 0100 | Make builtin subagents inherit the parent permission mode | Accepted |
| 0101 | Model-aware image attachment transport | Accepted |
| 0102 | Publisher-owned plugin source with a Git-hosted artifact store | Accepted for implementation (supersedes 0006) |
| 0103 | Compact context usage summary | Accepted (amends 0047) |
| 0104 | Plugin-contributed work panel views | Accepted |
| 0105 | Ship Files as a bundled plugin; keep Review in the host | Accepted (Terminal clause superseded by 0108) |
| 0106 | Keep only five core builtin commands | Accepted |
| 0107 | Make current-session task notification suppression atomic | Accepted |
| 0108 | Remove the built-in interactive terminal | Accepted |
| 0109 | Open Files entries with the OS-associated application | Accepted |
| 0110 | Version the plugin panel chrome spacing contract | Accepted |
| 0111 | Reveal Files in the OS File Manager | Accepted |
| 0112 | Agent Capability Management Roots and Settings IA | Accepted |
| 0113 | Persist the New Task empty slot immediately and deduplicate it by message count | Accepted |
| 0114 | Persist Provider Model Bindings and Thinking Configuration | Accepted |
| 0115 | Keep plugin clipboard history host-owned and in memory | Accepted (amended 2026-08-21) |
| 0116 | Add OpenCode Go as a Fixed Provider Preset | Accepted (amended: session routing headers) |
| 0117 | Preserve the Windows taskbar entry for native minimize | Accepted |
| 0118 | Keep queued prompts renderer-owned and stop runs at turn boundaries | Accepted |
| 0119 | Event-Driven Subagent Timeouts | Accepted for implementation |
| 0120 | Bounded Session History Windows | Accepted |
| 0121 | Keep Composer prompt enhancement one-shot and main-owned | Accepted |
| 0122 | Reserve native width while the work panel is visible | Superseded by 0151 |
| 0123 | Use native taskbar minimize for Windows/Linux window controls | Accepted |
| 0124 | Bind Temporary Sessions to Their Own Scratch Workspace | Accepted |
| 0125 | Renderer Ships Derived Brand Marks and Minified Output | Accepted |
| 0126 | Agent Capability Pages Are One Workbench That Can Author | Accepted |
| 0127 | Transcript Layout Index and Identity-Based Truncation | Accepted |
| 0128 | Share one bounded budget for transient provider failures | Accepted |
| 0129 | The Subagent Idle Watchdog Bounds Silence, Not Slowness | Amended by 0166 (watchdogs no longer kill) |
| 0130 | Bounded Mounted Transcript Window | Accepted |
| 0131 | Spill Large Composer Text Pastes into Session Scratch | Accepted |
| 0132 | Attribute cross-display window moves to the user | Accepted |
| 0133 | Use models.dev as the primary model catalog with pi-ai fallback | Superseded by 0134 |
| 0134 | Use models.dev as the sole model metadata source with a local snapshot | Accepted |
| 0135 | Retry unchanged edited prompts | Accepted |
| 0136 | Preserve the active task boundary across context compaction | Accepted |
| 0137 | Retained Session Panes | Accepted (amends 0130 clauses 4/5) |
| 0138 | Subagent Peer Messaging | Superseded by 0147 |
| 0140 | Fold the Three Peer Tools Into One `Peer` Tool | Superseded by 0147 |
| 0141 | Make Expanded Sidebar Width User-Resizable | Accepted |
| 0142 | Allow non-loopback HTTP MCP endpoints with explicit risk disclosure | Accepted |
| 0143 | Make Session Titles User-Renamable | Accepted |
| 0144 | Allow User-Configured Thinking-Level Overrides | Accepted |
| 0145 | Publish Native macOS Intel Artifacts | Accepted (amended by D353 / 0191) |
| 0146 | Assign outer and inner work-panel resize ownership by boundary | Superseded by 0151 |
| 0147 | A2A Protocol Stack for Subagent Coordination | Superseded by 0165 |
| 0148 | Explicitly disable application keyboard shortcuts | Accepted |
| 0149 | Calm transcript running-status motion | Accepted |
| 0150 | Inline SVG empty-home agent mark | Superseded by 0152 |
| 0151 | Keep the work panel inside the fixed application window | Accepted |
| 0152 | Eight-frame empty-home mascot GIF | Accepted |
| 0153 | Checkpoint the streaming reply beside the transcript | Accepted |
| 0154 | Reveal the New Task empty destination before host IO | Accepted |
| 0155 | Add Zhipu / Z.AI Named Endpoint Presets | Accepted |
| 0156 | Simplify the Add-Provider Common Path | Accepted |
| 0157 | Main-owned GitHub issue feedback | Accepted |
| 0158 | Keep approval cards focused and remember the selected mode | Accepted |
| 0159 | Generated plugin settings and plugin-local shortcuts | Accepted |
| 0160 | Shipped locale registry and searchable language picker | Accepted (amended by 0182) |
| 0161 | Searchable theme picker matching language | Accepted |
| 0162 | Cross-session A2A addressing | Superseded by 0165 |
| 0163 | Transcript File References Render as Previewable Chips | Accepted |
| 0164 | Parent agents collaborate across conversations | Superseded by 0165 |
| 0165 | Withdraw the A2A / Peer coordination stack | Accepted (supersedes 0147 / 0162 / 0164) |
| 0166 | Parent-judged subagent lifetime | Accepted (amends 0089 / 0119 / 0129; fatal-error path amended by 0189) |
| 0167 | Agent-chosen Bash timeout | Accepted (amends 0054 / D190 / D273) |
| 0168 | Main-owned http(s)/mailto allowlist for `openExternal` | Accepted (amends 0109) |
| 0169 | Classified file preview and live workspace events for plugin views | Accepted (amends 0104 / 0105 / 0109 / 0111) |
| 0170 | Ship the work-panel browser as a bundled plugin over public CDP | Accepted (amends 0019 / 0104 / 0105) |
| 0171 | Host-owned completed-turn token history | Accepted (amended by 0173) |
| 0172 | Contained in-chat image display | Accepted (amends fs/read workspace-only clause) |
| 0173 | Plugin-owned token usage dashboard | Accepted (amends 0171) |
| 0174 | Host-owned plugin completions and session context | Accepted (amends D019) |
| 0175 | Explain quiet active turns with live agent activity status | Accepted |
| 0176 | Per-provider User-Agent override | Accepted (amends 0095 / 0156; header map superseded by 0178) |
| 0177 | User-configurable outbound proxy | Accepted |
| 0178 | Per-provider custom HTTP headers | Accepted (amends 0176 / 0095 / 0156) |
| 0179 | Import model configuration from local agent stores | Accepted |
| 0180 | Custom global UI type scale | Accepted |
| 0181 | Main-owned picker capabilities | Accepted |
| 0182 | Traditional Chinese shell locale | Accepted (amends 0160) |
| 0183 | P0 international shell locales | Accepted (amends 0160 / 0182) |
| 0184 | Dock the context usage inspector in the composer toolbar | Accepted (amends 0047 / 0103) |
| 0185 | Korean shell locale | Accepted (amends 0160 / 0183) |
| 0186 | Summarize First-Turn Session Titles with a Main-Owned One-Shot | Accepted |
| 0187 | Focus-Aware Native Task Notifications | Accepted (amends 0107 / D117) |
| 0188 | Preserve distinct credentials during model configuration import | Accepted (amends 0179 / D342) |
| 0189 | Parent fatal error aborts leftover delegates | Accepted (amends 0166 / D328) |
| 0190 | Host-gated large-file and dropped-file access | Accepted |
| 0191 | Label Both macOS Release Architectures | Accepted (amends 0145 / D353) |
| 0192 | Alias a configured model and make model ids copyable | Accepted (amends D266) |
| 0193 | Last-request occupancy in the context inspector | Accepted (amends 0047 / 0103 / 0184) |
| 0194 | Optional subagent thinking override | Accepted for implementation |
| 0195 | Viewport-fixed work panel toggle | Accepted (amends 0068 / 0085) |
| 0196 | Show provider retry causes in the active-turn status | Accepted (amends 0175) |
| 0197 | Publish a Windows Portable Executable | Accepted (amends 0022 / D126) |
| 0198 | Name every quiet interval on the live activity row | Accepted (amends 0175 / 0186) |
| 0200 | Host-owned plugin session import and ownership API | Accepted |
| 0201 | Explicit plugin project ids and host-owned session refresh | Accepted |
| 0202 | Expose effective subagent thinking metadata | Accepted |
| 0203 | Local MCP control plane for desktop operations | Accepted (amended by D372) |
| 0204 | Explicit unsigned macOS first-launch helper | Accepted |
| 0205 | Remote Agent Control uses a dedicated Host boundary | Accepted for implementation (post-MVP; amended by D374, D375, and D385) |
| 0206 | Extend provider retries and show bounded progress | Accepted |
| 0207 | Allow three same-path mutation recovery failures | Accepted (amends 0087 / D186) |
| 0208 | Plugin desktop control requires native user consent | Accepted |
| 0209 | PowerShell 7 as a selectable Windows command shell | Accepted (amends 0054 / D190; issue #151 / PR #191) |
| 0210 | Subagent output-token cap | Accepted (extends 0062 / 0063; issue #171 / PR #193) |
| 0211 | Plan-safe plugin actions for read-only inspection | Accepted (amends 0052 / 0053 / 0170; D384) |
| 0212 | Remove diagnostic timing log streams | Accepted (amends 0046 / D183) |
| 0213 | Persist the Host-owned turn queue in host-core | Accepted |
| 0214 | Trusted extensions run in the Agent sidecar | Accepted (v1 implemented; amended by D388 / ADR 0215) |
| 0215 | Agent extensions are a plugin contribution | Accepted (implemented) |
| 0216 | Truncate regenerates under the RPC lock | Accepted (amends 0060 / 0127; issue #211) |
| 0217 | Host stdout sender must not outlive serve | Accepted (amends 0216; issue #211) |
| 0218 | Effective image-input overrides across Composer and transport | Accepted (amends 0101 / D243) |
| 0219 | User-invoked Skills in the composer slash menu | Accepted (amends D123 / D174 / ADR 0024 / ADR 0039) |
| 0220 | Keep Windows work-panel chrome single-purpose | Accepted (amends D154 / D357 / ADR 0195) |
| 0221 | Render canonical thinking-level values without translation | Accepted (amends D369 / ADR 0202) |
| 0222 | Native file and folder drops in the Composer | Accepted (amends ADR 0101 / D397) |
| 0223 | Context Usage Display Preference | Accepted (amends 0184) |
| 0224 | Right panel tab strip and data-driven add menu | Accepted (issue #229) |
| 0225 | Restore deferred tools from effective session context | Accepted (issue #225) |
| 0226 | Reserve chat width for composer controls | Accepted |
| 0227 | Project group manual ordering | Accepted (amended by 0228) |
| 0228 | Long-press the project title to reorder | Accepted (amended by 0229) |
| 0229 | Press-and-move project title reorder | Accepted (amends 0228) |
| 0230 | Skill ships with the Agent core tool set | Accepted (amends D174 / ADR 0048 / ADR 0219; issue #204) |
| 0231 | Ideographic comma opens the composer slash menu | Accepted (amends D123 / D139 / ADR 0024; issue #65) |
| 0232 | Keep macOS DMG opening guidance text-only | Accepted (amends D371 / ADR 0204) |
| 0233 | Renderer-owned multi-folder project creation | Accepted (amends ADR 0011 / ADR 0016) |
| 0234 | Keep project memory host-owned and path-scoped | Accepted |
| 0235 | Preserve domain facades and enforce architecture budgets | Accepted |
| 0236 | Restore archived projects when session import adds a bound session | Accepted |
| 0237 | Prioritize MainChat in the three-column shell | Accepted (amends ADR 0226) |
