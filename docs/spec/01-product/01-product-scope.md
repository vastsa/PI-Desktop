# 01. Product Scope

## 1. Positioning

PI-Desktop is for developers and power users who want a local agent that can read/modify projects with visible control.

It combines:

- strong desktop UX
- pi agent capabilities
- Rust-backed local host operations
- user-extensible plugins
- standalone MCP servers, Skills, and Subagents

## 2. Target users

### Primary
- Developers using coding agents daily
- Users who need local file/command execution
- Users in the pi ecosystem

### Secondary
- Teams needing custom providers/base URLs
- Plugin authors extending workflows

## 3. Core scenarios

### A. Project Q&A
Open a repository and ask architecture/code questions.

### B. Controlled edits
Request a code change, review tool calls, approve writes.

### C. Run and diagnose
Run tests/commands, inspect outputs, iterate.

### D. Multi-session work
Keep parallel sessions for refactor, debugging, docs, etc.

### E. Custom plugin extension
Install or develop local plugins for commands, panels, tools, skills, themes,
MCP servers, resident services, and message-bus integrations.

### F. Approved plans and autonomous goals
Use Plan to review an implementation checkpoint before execution. Use Goal to
start bounded autonomous work directly from a user send, then inspect reported
criteria/evidence and pause, resume, or cancel from the Goal card.

### G. Daily workflow support
Import sessions from other local agents, prepare file references in the
composer, use the work panel for review/browser/files, manage
notifications, and run scheduled prompts manually or on a remembered cadence.

### H. Portable configuration sync

Configure an encrypted S3 vault for portable preferences and user-owned
capabilities, review category and credential inclusion, and reconcile changes
across devices without synchronizing conversation history or source files.

## 4. Current shipped scope

- Electron desktop app for macOS arm64 and Intel x64, Windows x64, and Linux x64 and arm64 release lanes
- English default UI + i18n framework
- Session create/switch/restore
- Multi-provider configuration
- Secure API key storage
- Streaming output + abort
- Workspace binding
- Builtin tools: Read / Write / Edit / Glob / Bash (+ Grep)
- Tool-call visualization
- Permission confirmations
- JSONL transcript persistence with a SQLite index
- Agent / Plan / Goal modes: Plan approval artifacts and independent host-owned Goal lifecycle
- Work panel: Review artifacts, Browser previews, transcript-linked files, and the vendored file manager view
- Project archive, multi-project sidebar, session fork/import, and notifications
- Opt-in local MCP control for project, session, Agent, workspace, and reviewed
  desktop operations
- Extensions page: local plugins, marketplace packages, MCP, Skills, and
  Subagents with activation scopes
- Scheduled task records with manual execution and cadence metadata
- Host-owned encrypted S3 configuration backup/sync with category selection,
  conditional-write probing, three-way merge, and local activation review
- Rust host core skeleton for privileged operations

## 5. Out of scope (current phase)

- Remote Gateway / browser remote control; local loopback MCP control is the
  explicitly bounded exception described by ADR 0203
- Full IDE experience
- Trusted plugin provenance/signatures and a capability sandbox for raw plugin
  Node APIs
- Mobile clients
- Billing systems
- Computer Use browser takeover

## 6. Operating modes

| Product selector | Behavior |
|---|---|
| Agent | The pi Agent runs with the full execution tool set under the selected permission policy. |
| Plan | The same pi Agent runs in planning state. It can inspect with Read/Glob/Grep/BrowserPreview, run Bash under the selected permission policy, use plan/context controls, and call `SubmitPlan(title, markdown, question)`. Host-core preserves the exact Markdown bytes in a new immutable `<workspaceRoot>/.pi/plan/*.md` artifact before separate approval; title/question remain structured approval fields and the card opens the artifact. Write/Edit/plugin tools are denied. |
| Goal | Direct user send starts the same Agent without Plan approval. Default 20 execution turns including the initial turn; optional soft token cap. Ordinary Agent permissions apply. The Goal card exposes progress, model-reported criteria/evidence, pause/resume/cancel, and budgets. |

Mode selection alone starts nothing. Only the user owner may start/resume Goal;
scheduled automation remains disallowed. Plan retains approval and hard mode
denies. Goal preserves ordinary path/sandbox/permission/rejection behavior,
including Write/Edit, delegation and plugins. Bash is not read-only under Auto.

Goal status is active, paused, blocked, completed, budget_exhausted or cancelled.
Restart pauses active goals and clears interrupted claims without replay;
mode-switch-away also pauses. Reports cannot change scope/budget or authorize
execution. Completed means all criteria reported met with evidence, not
independently host-verified. Legacy Goal approvals retain read/resolve/execute
semantics but never migrate into autonomous goals. `EnterGoalMode` and
`SubmitGoal` cannot create new goals.

Existing persisted `Chat` mode values migrate to `Plan`. New sessions and new
scheduled tasks default to Agent. The conversation surface may continue to use
the internal `page = "chat"` route value; that value is not an operating mode.

## 7. Success criteria

1. First useful chat in under 5 minutes
2. Complete one controlled local edit on a real project
3. Tool calls are readable and interruptible
4. Sessions survive restart
5. Renderer never has direct Node/FS privileges
6. UI is fully usable in English
7. A submitted Plan or persisted legacy Goal approval cannot execute without a separate
   matching approval; its exact Markdown bytes are preserved in a unique
   `.pi/<kind>/*.md` artifact and the approval row records its path, hash, and
   size

## 8. Naming

- Product: `PI-Desktop`
- Package: `pi-desktop`
- Application ID: `net.aiuo.pi-desktop`
- Window title: `PI-Desktop`

## 9. Platform strategy

| Platform | MVP | Notes |
|---|---|---|
| macOS Apple Silicon | Published | Primary development and acceptance platform; signing/notarization remains credential-gated |
| macOS Intel | Published | Native x64 DMG/ZIP release lane; signing/notarization remains credential-gated |
| Windows x64 | Published | NSIS installer, portable ZIP, and in-app update lane for NSIS; native qualification continues |
| Linux x64 and arm64 | Published | AppImage, deb, and rpm packages; AppImage update lane; glibc 2.35+ (Ubuntu 22.04, Debian 12, Fedora 36+); native qualification continues |
