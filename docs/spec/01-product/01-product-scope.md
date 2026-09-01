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

### F. Approved plans and goals
Use Plan to review an implementation checkpoint before execution, or Goal to
approve an outcome and acceptance criteria before the Agent chooses and runs
the steps.

### G. Daily workflow support
Import sessions from other local agents, prepare file references in the
composer, use the work panel for review/browser/files, manage
notifications, and run scheduled prompts manually or on a remembered cadence.

## 4. Current shipped scope

- Electron desktop app for macOS arm64 and Intel x64, Windows x64, and Linux x64 release lanes
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
- Agent / Plan / Goal operating contracts with host-owned approval artifacts
- Work panel: Review artifacts, Browser previews, transcript-linked files, and the bundled Files view
- Project archive, multi-project sidebar, session fork/import, and notifications
- Extensions page: local plugins, marketplace packages, MCP, Skills, and
  Subagents with activation scopes
- Scheduled task records with manual execution and cadence metadata
- Rust host core skeleton for privileged operations

## 5. Out of scope (current phase)

- Remote Gateway / browser remote control
- Cloud account sync
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
| Goal | The same pi Agent negotiates an outcome contract through `SubmitGoal(title, markdown, question)`, preserving an immutable `<workspaceRoot>/.pi/goal/*.md` artifact before separate approval. After approval it returns to Agent mode and works toward the stated acceptance criteria, reporting the criteria it verified or the boundary that stopped it. |

Plan and Goal are contract modes, not strict read-only security profiles: Bash
under `ask` or `accept-edits` prompts, while Bash under `auto` runs without
confirmation and may mutate the workspace or scratch directory. The mode
selector and `EnterPlanMode`/`EnterGoalMode` all address the same Agent;
approval transitions that Agent into Agent execution without creating a second
planner. Approval is approve/reject only, and the explicit execution permission
selection defaults to Ask. A host restart interrupts pending, queued, or
running contract work without replay; an already-approved interrupted run
leaves the session in Agent.

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
7. A submitted Plan or Goal cannot cross into execution without a separate
   matching approval; its exact Markdown bytes are preserved in a unique
   `.pi/<kind>/*.md` artifact and the approval row records its path, hash, and
   size

## 8. Naming

- Product: `PI-Desktop`
- Package: `pi-desktop`
- Application ID: `com.pi-desktop.app`
- Window title: `PI-Desktop`

## 9. Platform strategy

| Platform | MVP | Notes |
|---|---|---|
| macOS Apple Silicon | Published | Primary development and acceptance platform; signing/notarization remains credential-gated |
| macOS Intel | Published | Native x64 DMG/ZIP release lane; signing/notarization remains credential-gated |
| Windows x64 | Published | NSIS installer and in-app update lane; native qualification continues |
| Linux x64 | Published | AppImage and deb packages; AppImage update lane; native qualification continues |
