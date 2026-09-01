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
| 0001 | Use Electron as desktop shell | Accepted |
| 0002 | Use pi Agent Harness as agent engine | Accepted |
| 0003 | Hybrid runtime (historical main-process note) | Superseded in part |
| 0004 | No remote Gateway in MVP | Accepted |
| 0005 | User-installable plugin system | Accepted |
| 0006 | Marketplace postponed after local plugin runtime | Accepted |
| 0007 | Plugin package format `.piplug` (zip) | Accepted |
| 0008 | Plugin runtime isolation target = separate process | Accepted (Target) |
| 0009 | English-first globalization | Accepted |
| 0010 | Rust backend host core | Accepted |
| 0011 | Freeze host RPC, storage ownership, and mode defaults | Accepted |
| 0012 | Universal provider & model coverage | Accepted |
| 0013 | Consolidate settings navigation into four destinations | Superseded in part by 0026 |
| 0014 | Adopt host-owned storage schema v2 | Accepted |
| 0015 | Make settings content responsive to window width | Accepted |
| 0016 | Organize the sidebar around retained multi-project tabs | Accepted |
| 0017 | Remove composer workspace context rail | Accepted |
| 0018 | Carry thinking mode through the complete session pipeline | Accepted |
| 0019 | Work panel subsystems (embedded browser, git review, file browsing) | Superseded in part by 0108 |
| 0020 | Configuration provider studio | Accepted |
| 0021 | Platform application chrome | Superseded in part by 0025 |
| 0022 | Application update delivery | Accepted |
| 0023 | Independent conversation session fork | Accepted |
| 0024 | Composer slash commands and @ file references | Accepted |
| 0025 | Keep application menus out of Windows/Linux windows | Accepted |
| 0026 | Move the Projects index into Settings as an archive | Accepted |
| 0027 | Make pi-ai authoritative for model metadata | Accepted |
| 0028 | Scope work-panel runtime contexts to conversations | Accepted |
| 0029 | Separate native-window and work-panel resize ownership | Superseded in part by 0032 |
| 0030 | Turn-boundary context checkpoint compaction | Accepted |
| 0031 | Keep composer prompt rows free of brand icons | Accepted |
| 0032 | Reserve native width for the docked work panel | Accepted (amended by 0033 and 0122) |
| 0033 | Internal-dock work panel (no native window expansion) | Superseded by 0122 |
| 0034 | Merge command palette into global search | Accepted |
| 0035 | Surface the OS locale through the preload bridge | Accepted |
| 0036 | Split Settings into AI and Shortcuts destinations | Accepted |
| 0037 | Resolve project instructions in Electron main | Accepted |
| 0038 | Bridge plugin-declared MCP servers in Electron main | Accepted |
| 0039 | Activate plugin skills and ship plugin authoring as a first-party devkit | Accepted (skill delivery revised by D174) |
| 0040 | Resident plugin services and the inter-plugin message bus | Accepted |
| 0041 | Bound host runtime resources and decouple message persistence | Accepted |
| 0042 | Message-scoped inline review cards | Accepted |
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
| 0058 | Extensions page density and theme-readable button surfaces | Accepted |
| 0059 | Persist composer clipboard files in session scratch | Accepted |
| 0060 | Archive the regenerate branch under the RPC lock | Accepted |
| 0061 | Imperceptible background context compaction | Accepted (amends 0030 / 0049; clauses 2/4/6/7/8 amended by 0064) |
| 0062 | Bounded subagents behind a Task tool | Accepted for implementation |
| 0063 | A managed surface for subagent definitions | Accepted for implementation |
| 0064 | Codex-parity context compaction | Accepted (amends 0061 / 0030) |
| 0066 | Empty home direct bottom composer | Accepted for implementation (amends D111) |
| 0067 | ChatGPT-inspired empty-home starter guidance | Superseded by D206 |
| 0068 | Add a keyboard entry point for the work panel | Accepted for implementation |
| 0069 | Make native-tool path mistakes recoverable | Accepted for implementation |
| 0070 | Separate composer file-reference display from prompt serialization | Accepted for implementation |
| 0071 | Adopt an Apple-inspired global corner hierarchy | Accepted for implementation |
| 0072 | Add a global plugin launcher | Accepted for implementation |
| 0073 | Stage next-turn composer configuration and preserve stopped throughput | Accepted for implementation |
| 0074 | Native notification permission for plugins | Accepted |
| 0075 | Manual reload for development-plugin permission ceilings | Accepted |
| 0076 | Capture the Windows-reserved plugin launcher chord in host-core | Accepted |
| 0079 | Use VitePress for the bilingual documentation site | Accepted |
| 0080 | Prewarm the global plugin launcher after boot | Accepted |
| 0081 | Host-owned cross-platform plugin panel chrome | Accepted |
| 0082 | Localized and page-adaptive plugin panel chrome | Accepted |
| 0083 | Custom global UI font | Accepted |
| 0084 | Defer new-task session creation until the first message | Accepted |
| 0085 | Make the work panel shortcut a toggle | Accepted (amends 0068) |
| 0086 | Keep macOS on the regular activation policy | Accepted |
| 0087 | Replace textual Edit matching with a line-anchored, tag-verified contract | Accepted for implementation (amends 0043 / 0069) |
| 0088 | Declared file scope and recoverable deletion for plugins | Accepted (continues 0008 D009) |
| 0089 | Proactive background subagent delegation | Accepted for implementation |
| 0090 | User-configurable close behavior with close-to-tray | Accepted for implementation |
| 0091 | Route mid-stream rate limits through the bounded retry | Accepted (amends 0050) |
| 0092 | Use a plugin-owned surface with a host window-control capsule | Accepted |
| 0093 | Keep a strict 46px plugin drag band with a minimal capsule | Accepted |
| 0094 | Admit one desktop instance per data directory | Accepted |
| 0095 | Sign in with a vendor account instead of pasting an API key | Accepted for implementation |
| 0096 | Flatten the Settings directory and colocate marketplace source configuration | Accepted |
| 0097 | Place global defaults under the AI Settings destination | Accepted |
| 0098 | Treat every vendor OAuth account as an independent provider row | Accepted for implementation |
| 0099 | Add titled visual clusters to the Settings directory | Accepted |
| 0100 | Make builtin subagents inherit the parent permission mode | Accepted |
| 0101 | Route image attachments by model vision capability | Accepted |
| 0102 | Publisher-owned plugin source with a Git-hosted artifact store | Accepted for implementation (supersedes 0006) |
| 0103 | Compact context usage summary | Accepted (amends 0047) |
| 0104 | Let plugins contribute work panel views | Accepted |
| 0105 | Ship Files as a bundled plugin; keep Review in the host | Accepted (Terminal clause superseded by 0108) |
| 0106 | Keep only five core builtin commands | Accepted |
| 0107 | Make current-session task notification suppression atomic | Accepted |
| 0108 | Remove the built-in interactive terminal | Accepted |
| 0109 | Open Files entries with the OS-associated application | Accepted |
| 0110 | Version the plugin panel chrome spacing contract | Accepted |
| 0111 | Reveal Files in the OS file manager | Accepted |
| 0113 | Persist the New Task empty slot immediately and deduplicate it by message count | Accepted |
| 0114 | Persist provider model bindings and thinking configuration | Accepted |
| 0116 | Add OpenCode Go as a fixed provider preset | Accepted |
| 0117 | Preserve the Windows taskbar entry for native minimize | Accepted |
| 0118 | Keep queued prompts renderer-owned and stop runs at turn boundaries | Accepted |
| 0119 | Event-driven subagent timeouts | Accepted for implementation |
| 0120 | Bounded session history windows | Accepted |
| 0121 | Keep Composer prompt enhancement one-shot and main-owned | Accepted |
| 0122 | Reserve native width while the work panel is visible | Accepted |
| 0123 | Use native taskbar minimize for Windows/Linux window controls | Accepted |
| 0124 | Bind temporary sessions to their own scratch workspace | Accepted |
| 0125 | Renderer-derived brand marks and minified renderer output | Accepted |
| 0126 | Agent capability workbench | Accepted |
| 0127 | Transcript layout index and identity-based truncation | Accepted |
| 0128 | Share one bounded budget for transient provider failures | Accepted |
| 0129 | The subagent idle watchdog bounds silence, not slowness | Accepted for implementation |
| 0130 | Bounded mounted transcript window | Accepted |
| 0131 | Spill large composer text pastes into session scratch | Accepted |
| 0132 | Attribute cross-display window moves to the user | Accepted |
| 0133 | Use models.dev as the primary model catalog with pi-ai fallback | Superseded by 0134 |
| 0134 | Use models.dev as the sole model metadata source with a local snapshot | Accepted |
| 0135 | Retry unchanged edited prompts | Accepted |
| 0136 | Preserve the active task boundary across context compaction | Accepted |
| 0137 | Retained session panes | Accepted (amends 0130 clauses 4/5) |
| 0138 | Subagent peer messaging | Accepted (amended by 0140) |
| 0140 | Fold the three peer tools into one `Peer` tool | Accepted |
| 0141 | Make expanded sidebar width user-resizable | Accepted |
| 0142 | Allow non-loopback HTTP MCP endpoints with explicit risk disclosure | Accepted |
| 0144 | Allow user-configured thinking-level overrides | Accepted |
| 0145 | Publish native macOS Intel artifacts | Accepted |
