# 01. IPC Protocol

## 1. Goal

Define a stable contract between the renderer and main.

Principles:

1. All capabilities go through the preload allowlist
2. Requests/responses are typed
3. Long-running tasks use event streams, not a single oversized response
4. Errors must have a code + message

## 2. API Groups

| Domain | Description |
|---|---|
| `app` | App info, health checks |
| `agent` | Conversation, queued-send stop/abort, status, and interactive asktool resolution |
| `plan` | Plan proposal listing, resolution, and change events |
| `session` | Session CRUD / history |
| `settings` | Config read/write |
| `secrets` | Secret write/delete/exists (never return plaintext to UI logs) |
| `project` | Workspace selection and query |
| `tool` | Permission confirmation callback |
| `shell` | Host shell catalog and persisted default shell |
| `log` | Diagnostics that the frontend can display |
| `plugin` | Plugin install/enable-disable/query/permissions |
| `commandPalette` | Command palette search and execution |
| `workspace` | Workspace selection and legacy working-tree diagnostics |
| `browser` | Work panel embedded preview navigation/bounds/visibility + state events |
| `fs` | Work panel workspace file listing/reading/reveal (read-only) |
| `window` | Frameless window state, controls, and bounded work-panel width reservation |
| `menu` | Allowlisted application-menu commands and native editing/window actions |
| `notification` | Durable inbox list/read/clear and new/activated events |

## 3. Channel Conventions

```text
invoke: pi-desktop/<domain>/<action>
event: pi-desktop/<domain>/event/<name>
```

Examples:

- `pi-desktop/agent/prompt`
- `pi-desktop/agent/stop`
- `pi-desktop/agent/abort`
- `pi-desktop/agent/event/message`
- `pi-desktop/agent/askTool/resolve`
- `pi-desktop/session/list`
- `pi-desktop/project/open`
- `pi-desktop/project/openFolder`

## 4. Common Response Envelope

```ts
type Result<T> =
 | { ok: true; data: T }
 | { ok: false; error: AppError };

type AppError = {
 code: string;
 message: string;
 details?: unknown;
 retriable?: boolean;
};
```

## 5. Agent API

### 5.1 prompt

```ts
type AgentPromptRequest = {
 sessionId: string;
 content: string;
 attachments?: AgentPromptAttachment[];
 /** Truncate durable transcript to N leading messages before append (regenerate). */
 truncateBefore?: number;
 /** Renderer snapshot used to close the prompt-to-completion notification race. */
 viewingSessionId?: string | null;
};

type AgentPromptAttachment = {
 path: string;
 name: string;
 kind: "image" | "file";
 mimeType?: string;
 size?: number;
};

type AgentPromptResponse = {
 accepted: boolean;
 turnId: string;
};
```

Slash template expansion (D123): when `content` starts with `/name` and the
name matches a loaded pi prompt template, the main-process handler expands
the invocation (`parseCommandArgs` + `substituteArgs`) before persisting.
The persisted user message stores `content = expanded text` plus an optional
`command: string` field carrying the typed invocation for transcript
display. Reseed replays `content`, so the agent context is identical across
restarts. Builtin/plugin slash aliases never reach this channel — the
renderer executes them locally. Unknown `/foo` passes through as literal
content. Ordinary `@path` tokens are not transformed anywhere in the pipeline
(D124). Composer-owned pasted file references travel separately in
`attachments`; they are validated and prepared by Electron main at dispatch,
so a pasted image does not depend on the model being able to interpret a path
token.

Prompt execution resolves `mode`, `providerId`, `modelId`, and `thinkingLevel`
from the durable session record and snapshots the effective command shell ID and
dialect for Bash.
The renderer changes those values through
`pi-desktop/session/configure` while the session is idle:

```ts
type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium"
  | "high" | "xhigh" | "max";

type SessionConfigureRequest = {
  id: string;
  mode: "plan" | "goal" | "agent";
  providerId?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
};
```

`session/configure` is accepted only while the session is idle. Mode, provider,
model, permission, and shell-default changes are rejected while a turn or a
Plan/Goal `pending`/`queued`/`running` record exists. The renderer may keep these
controls editable during a turn, but it queues the latest full configuration
locally and invokes this channel only after the terminal event; the running
turn never observes that optimistic next-turn choice.

Only a changed effective global `defaultCommandShell` is idle-only across all
affected sessions: any active turn or pending/queued/running Plan/Goal work blocks
that shell change, while an omitted or idempotent shell field does not.

`attachments` is an additive prompt field. The renderer sends metadata and a
source path only; it never sends binary data. Electron main validates the path
against the session scratch/project roots, persists image bytes in the
content-addressed attachment store, and derives the exact model transport from
the models.dev record when matched, or the pi-ai fallback record. A known
model whose selected catalog input includes `image` receives eligible images as
transient pi-ai image blocks. Unknown/non-vision models and
images above the 20 MiB inline bound receive a safe `@path` fallback. Main
uses streamed hashing and file copying for images above that bound, and the
sidecar uses the same bounded-read rule when rebuilding history. The durable
user message stores `content` plus attachment metadata/ref, never base64.
Invalid attachment paths fail with `PATH_OUTSIDE_WORKSPACE`.

Regenerate history (D109) also uses session channels:

- `pi-desktop/session/saveRevision`
- `pi-desktop/session/listRevisions`
- `pi-desktop/session/activateRevision`

Root user turns may include `revisionRootId`, `revisionCount`, and
`activeRevision`. Activating a revision replaces the live tail with
`prefix + archived branch` and disposes the session agent.
The sidecar receives only the prepared attachment subset needed for the
current turn. On a vision runtime, persisted image refs are hydrated from the
session-bound attachment/scratch roots when history is rebuilt; oversized or
unavailable images remain path fallbacks. This keeps renderer, main, sidecar,
models.dev/pi-ai catalogs, and host persistence on one capability-aware
contract.

### 5.2 stop at the next turn boundary

```ts
type AgentStopRequest = {
 sessionId: string;
 turnId?: string;
};

type AgentStopResponse = {
 requested: boolean;
};
```

`pi-desktop/agent/stop` requests a graceful stop for the active runtime. The
sidecar evaluates the one-shot request after the current assistant response and
completed tool batch, at the same boundary where it would otherwise start the
next model request. The current durable turn then emits `agent_end` and is
finalized as `completed`; the request does not abort the provider stream,
cancel running tools, or open a second concurrent turn. An idle session returns
`requested: false`.

The renderer owns the removable, in-memory queued-prompt list per session. It
calls this channel only for a queued item's **Send now** action and releases
that item through the ordinary `agent/prompt` flow after the terminal event.

### 5.3 abort

```ts
type AgentAbortRequest = {
 sessionId: string;
 turnId?: string;
};
```

The abort request and response carry no Composer draft or file-reference data.
If renderer smart Stop undoes an unanswered user turn, restoration comes from
the renderer's session/turn-scoped pre-serialization snapshot; the existing
transcript rewrite removes the sent row without changing protocol version.

### 5.4 compact (protocol v9)

```ts
type AgentCompactRequest = { sessionId: string };
type AgentCompactResponse = { accepted: boolean };
```

`pi-desktop/agent/compact` creates a model-context checkpoint for an idle
session. It is available even when automatic context protection is disabled.
Missing provider/session configuration fails through the normal `AppError`
envelope; an active turn or compaction returns `AGENT_BUSY`.

### 5.5 Plan and Goal checkpoint approval

Contract approval is separate from a tool permission. Plan and Goal share this
whole surface; `kind` is the only discriminator (**D198**). The renderer receives
the
host-written artifact metadata from the same Agent and resolves it through
typed preload IPC; it never changes the session mode optimistically. Contract
entry
and submission remain Agent/host operations, not renderer preload methods.

```ts
type PlanningState = "inactive" | "planning" | "awaiting_approval";

type ProposalKind = "plan" | "goal";

type GlobalPermissionMode = "ask" | "accept-edits" | "auto";

type PlanApprovalAction = "approve" | "reject";

type PlanProposalStatus =
  | "pending" | "approved" | "rejected"
  | "expired" | "interrupted";

type PlanExecutionState =
  | "queued" | "running" | "completed" | "interrupted";

// Same shape for SubmitPlan and SubmitGoal; the tool name selects the kind.
type SubmitPlanInput = {
  title: string;
  markdown: string;
  question: string;
};

type PlanArtifact = {
  relativePath: string; // `.pi/plan/<unique-name>.md` or `.pi/goal/<unique-name>.md`
  sha256: string;
  sizeBytes: number;
};

type PlanProposal = {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  // Legacy rows written before the discriminator existed read back as `plan`.
  kind: ProposalKind;
  plan: string;
  markdown: string;
  title: string;
  question: string;
  status: PlanProposalStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  errorCode?: string;
  artifact?: PlanArtifact;
  version: number;
  executionId?: string;
  executionState?: PlanExecutionState;
};

type PlanExecution = {
  id: string;
  proposalId: string;
  sessionId: string;
  kind: ProposalKind;
  plan: string;
  title: string;
  question: string;
  artifact: PlanArtifact;
  targetPermissionMode: GlobalPermissionMode;
  state: PlanExecutionState;
};

type PlanningStateEvent = {
  sessionId: string;
  state: PlanningState;
  // Absent only for `inactive` transitions that carry no proposal.
  kind?: ProposalKind;
  proposalId?: string;
  title?: string;
  markdown?: string;
  question?: string;
  artifact?: PlanArtifact;
  version?: number;
  plan?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  executionId?: string;
  executionState?: PlanExecutionState;
  proposal?: PlanProposal;
};

type PlansPendingResult = {
  plans: PlanProposal[];
  state?: PlanningState;
  // The contract being negotiated, for mode chip and approval copy.
  kind?: ProposalKind;
};

type PlanResolveIdentity = {
  proposalId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  version?: number;
};

type PlanResolveRequest =
  | (PlanResolveIdentity & {
      action: "approve";
      targetPermissionMode: GlobalPermissionMode;
    })
  | (PlanResolveIdentity & { action: "reject" });

type PlanResolutionResult = {
  ok: boolean;
  proposal: PlanProposal;
  state: PlanningState;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  execution?: PlanExecution;
};
```

Preload methods:

- `pi-desktop/plans/pending({ sessionId? }) -> PlansPendingResult`
- `pi-desktop/plans/resolve(PlanResolveRequest) -> PlanResolutionResult`

Electron forwards each host `plans.changed` notification unchanged to the
renderer through the stable shared `IPC.event.plansChanged` channel
(`pi-desktop/plans/event/changed`). This is the Plan/Goal change event surface;
the
renderer does not receive contract approval transitions as AgentEvent variants.
`plans.pending` returns only currently pending approval rows. Terminal
`plan_approvals` rows remain durable Host records, but are not renderer
hydration data; the renderer retains its latest contract snapshot only for the
current renderer lifetime while live `plans.changed` events arrive.

For `approve`, host-core and Electron require an explicit
`targetPermissionMode`; Electron never fills it from stored settings. The
renderer initializes each approval to Ask, which remains the product default,
and the host does not persist the selection as the next approval default.
`reject` carries no permission mode.
Responses with a wrong proposal, session, turn, tool-call, version, or expired
host-owned deadline fail with a stable Plan/Goal approval error. There is no
request-changes action.

### 5.5 getStatus

```ts
type AgentStatus = {
 sessionId: string;
 isRunning: boolean;
 currentTurnId?: string;
 modelId?: string;
 pendingToolConfirmations: number;
};
```

## 6. Agent Events

Pushed from main → renderer:

```ts
type AgentEventEnvelope = {
 sessionId: string;
 turnId?: string;
 ts: number;
 event: AgentEvent;
 /** Set on events emitted inside a subagent (D201, ADR 0062): the `Task` call
  * that spawned it, and the definition name. */
 parentToolCallId?: string;
 agentName?: string;
};

type AgentEvent =
 | { type: "agent_start" }
 | { type: "agent_end"; messageIds: string[] }
 | { type: "turn_start" }
 | { type: "turn_end" }
 | { type: "message_start"; message: UiMessage }
 | { type: "message_update"; message: UiMessage;
     deltaText?: string; deltaThinking?: string }
 | { type: "message_end"; message: UiMessage }
 | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
 | { type: "tool_update"; toolCallId: string; partialResult?: unknown }
  | { type: "tool_end"; toolCallId: string; result: unknown; isError?: boolean;
      toolUsage?: ToolTokenUsage }
  | ({ type: "planning_state" } & Omit<PlanningStateEvent, "sessionId">)
  | { type: "tool_permission_request"; request: ToolPermissionRequest }
  | { type: "compaction_start";
     reason: "manual" | "threshold" | "overflow" }
 | { type: "compaction_end";
     reason: "manual" | "threshold" | "overflow";
     ok: boolean; tokensBefore?: number; firstKeptMessageId?: string;
     willRetry: boolean; fallback?: "retained_tail";
     mark?: { id: string; throughMessageId: string;
              generation: number; summaryTokens: number;
              summarized: boolean };
     error?: { code: string; message: string } }
 | { type: "error"; error: AppError }
 | { type: "status"; status: AgentStatus };
```

> These are **UI-normalized events**, not a pass-through of raw pi events.
> `packages/agent-runtime` is responsible for mapping pi events to this model.

`planning_state` is the agent-runtime's local planning projection. Its optional
proposal and execution fields mirror the shared `PlanningStateEvent` shape
(`proposal`, `executionId`, and `executionState`). The full approved execution
descriptor uses `PlanExecution` and is carried by the host result/notification.
The authoritative host approval/queue transition is the separate `plans.changed`
notification forwarded through `IPC.event.plansChanged`.
`tools.output` is a host notification consumed by `packages/agent-runtime`
while a Bash tool runs; it is not an AgentEvent.

`turn_end` closes one model/tool turn but is not a terminal desktop run event:
another provider request may follow immediately. Renderer busy state and
durable turn completion therefore settle only on `agent_end` or `error`.
Compaction is always inline: `compaction_start` keeps the run busy, a manual
operation settles on its matching `compaction_end`, and threshold/overflow
compaction stays inside the active agent run. There is no pre-computed phase to
distinguish (D203).

`compaction_end.mark` is present whenever a checkpoint was installed. It is the
renderer's whole view of that compaction: `id`, the `throughMessageId` anchor the
transcript row sits after, `generation` (how many checkpoints this session has
installed), `summaryTokens` (the summary's estimated context cost), and
`summarized` (`false` when the window rolled over without asking the model for a
summary). The record itself is not carried — its summary and retained tail are
far larger than an event should be — and is instead read from
`SessionDetail.compactions` on session open or fork.

Automatic summary failures may still produce a successful lifecycle event with
`fallback: "retained_tail"`; this means a durable, aggressively bounded tail
checkpoint was installed and the run may continue with reduced historical
context. Manual compaction never silently falls back.

Provider `error` events may include bounded diagnostic fields in
`AppError.details`: `phase` (`request` or `stream`), `providerStatus`,
`providerCode`, `providerWaitMs`, `streamMs`, and `retryAttempt`. These fields
are additive and redacted; they never carry credentials or an unrestricted
provider response. A transient stream failure may be replayed once inside the
same turn without a terminal `error` event or a duplicate assistant message.
The second failure emits the terminal normalized `STREAM_FAILED` error.

## 6a. Notification API (D117, protocol v4)

Durable inbox requests are allowlisted preload invokes that Electron forwards
to the singular host RPC domain without renderer access to SQLite:

- `pi-desktop/notification/list({ unreadOnly?, limit? })`
- `pi-desktop/notification/markRead({ id })`
- `pi-desktop/notification/markAllRead()`
- `pi-desktop/notification/clear()`

The renderer invokes
`pi-desktop/notification/setViewingSession({ sessionId })` whenever the chat
page's active session changes; `sessionId: null` clears the viewing context on
non-chat pages. A renderer-originated `agent/prompt` also carries a matching
`viewingSessionId` snapshot, which Electron installs before asynchronous turn
setup so a fast completion cannot beat the viewing-context update. Electron
combines this hint with Main-owned window visibility/focus at the terminal event
boundary. Missing, null, or mismatched context fails safe to notification. It
also invokes
`pi-desktop/notification/showNative({ id, sessionId, title, body })` after
localizing a new record. This Electron-only request never crosses into the host
RPC domain.

```ts
type AppNotification = {
  id: string;
  kind: "task.completed" | "task.failed";
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string;
  readAt?: string | null;
};

type NotificationListResult = {
  notifications: AppNotification[];
  unreadCount: number;
};

type NotificationChangedEvent = {
  notification: AppNotification;
};

type NotificationActivatedEvent = {
  id: string;
  sessionId: string;
};
```

Main sends two events:

- `pi-desktop/notification/event/changed` after `session.endTurn` returns a
  newly inserted record. Renderer merges the record into its bounded local list
  and recalculates the exact unread count. A terminal result already visible in
  the focused current chat, repeated terminal updates, and aborted turns emit
  nothing.
- `pi-desktop/notification/event/activated` after the user clicks Electron's
  native system notification. Renderer follows its existing session-selection
  path, including project activation for a project-bound session.

Electron owns the native surface while the renderer derives localized
title/body text from the structured record. Electron accepts `showNative` only
for a valid notification/session pair, shows a native notification only when
the main window is unfocused and the platform API is supported, then
restores/shows and focuses the window before emitting `activated`. There is no
native notification while focused and no permission, scheduled-reminder, or
plugin source in this contract. Native delivery is best-effort; the durable
inbox remains authoritative when the OS suppresses a banner. On Windows,
Electron Main registers `com.pi-desktop.app` as the process AppUserModelID
before readiness and before any window is created. The ID matches the NSIS
package identity so notification attribution, notification settings, taskbar
grouping, and installed shortcuts resolve to `PI-Desktop`, never the stock
Electron host.

The viewing-session hint is advisory and fail-safe: missing, stale, hidden, or
unfocused renderer state creates the durable notification. Suppression occurs
only when the main window is visible and focused and the reported chat session
matches the finishing session. Window creation, renderer reload, and renderer
process loss clear the hint before any later terminal event is evaluated.

## 7. Session API

```ts
type SessionSummary = {
 id: string;
 title: string;
 messageCount: number;
 projectPath?: string;
 modelId?: string;
 providerId?: string;
  mode: "plan" | "goal" | "agent";
 thinkingLevel: ThinkingLevel;
 supportsReasoning?: boolean;
 supportedThinkingLevels?: ThinkingLevel[];
 updatedAt: string;
 createdAt: string;
};

type UiMessage = {
 id: string;
 role: "user" | "assistant" | "system" | "tool";
 content: string;
 thinking?: string; // assistant reasoning, never folded into content
 usage?: MessageUsage; // provider-reported assistant usage
 responseDurationMs?: number; // model stream duration for throughput
 responseOutputTokens?: number; // estimated partial output when stop has no final usage
 toolName?: string;
 toolCallId?: string;
 toolArgs?: unknown;
 toolResult?: unknown;
 toolUsage?: ToolTokenUsage; // estimated tool call/result footprint
 error?: AppError;  // structured failure owned by this assistant turn
 createdAt: string;
 // Rows produced inside a subagent (D201, ADR 0062); absent on the session's own
 parentToolCallId?: string;   // `Task` call that spawned the delegate
 agentName?: string;          // delegate definition name
 // status/tool fields omitted here
};

type ToolTokenUsage = {
 argumentTokens: number;
 resultTokens: number;
 totalTokens: number;
 estimated: true;
};

type SessionDetail = SessionSummary & {
  messages: UiMessage[];
  /** Zero-based start offset when the renderer received a bounded page. */
  messageStart?: number;
  /** True when an older page can be requested with session.get. */
  hasMoreBefore?: boolean;
};
```

`messageCount` is the host-authoritative count of messages in the current
canonical transcript. The renderer uses it to distinguish an empty durable
session from a session whose title still looks untitled; title text is not a
session-state signal.

Electron main enriches session list/get/create/fork/configure results with
effective reasoning capability from the models.dev record for that session's
exact provider/API URL and model, or the pi-ai record when models.dev is
unavailable/missing. Missing metadata from both catalogs yields
`supportsReasoning: false` and `off`; cached discovery and legacy provider
claims do not replace catalog semantics. The Rust host remains authoritative
only for the durable `thinkingLevel`.

The global plugin launcher uses Electron-only allowlisted channels:

- `pi-desktop/pluginLauncher/toggle` shows or hides the centered utility window
- `pi-desktop/pluginLauncher/dismiss` hides it only when invoked by that window
- `pi-desktop/pluginLauncher/event/shown` resets its query, reloads installed
  plugins, and restores input focus after every invocation

The launcher reuses `plugin/list` and `plugin/openPanel`; it adds no host-core
plugin RPC. The Electron main process also calls the additive host method
`keyboard.setGlobalShortcut({ binding })` to enable the Windows-only fallback
for the reserved `Alt+Space` binding. Host-core emits the notification
`keyboard.shortcut({ binding: "Alt+Space" })` when its low-level Windows
keyboard hook detects the chord; the hook consumes that chord so the active
window system menu does not open. Non-Windows hosts treat the method as a
no-op. `responseDurationMs` and `responseOutputTokens` are optional transcript
metadata persisted in message metadata, so protocol v9 and storage schema v11
remain unchanged.

The Settings font picker (ADR 0083) reads installed system font families
through one Electron-only allowlisted channel:

- `pi-desktop/app/systemFonts` returns `string[]` of installed system font
  family names (platform tooling in Electron main — `system_profiler` on
  macOS as the fallback only, with `osascript` JXA bridging the fast CoreText
  query `CTFontManagerCopyAvailableFontFamilyNames` as the primary path,
  PowerShell on Windows, `fc-list` on Linux), deduplicated, sorted, with
  hidden `.`-prefixed families excluded. The main process caches the result
  for 60 seconds; failures resolve to `[]`. The host RPC and protocol version
  are unchanged.

Minimal interface:

- `session/list`
- `session/create`
- `session/fork({ sessionId, title?, throughMessageId? }) -> { session: SessionDetail }`
- `session/get({ id, messageBefore?, messageLimit?, contentLimit? })` — without
  read-window options returns the complete UI projection; with them returns a
  bounded newest/older page plus `messageStart` and `hasMoreBefore`. The
  content limit applies only to display values and never changes the lossless
  transcript or model context. `messageBefore` and `messageStart` are physical
  message-line positions in the transcript file, not deduplicated index counts.
- `session/delete`
- `session/rename`
- `session/importScan`
- `session/importRun(candidates) -> { imported, skipped, failed }`

Import candidates carry `projectPath: string | null`. A successful import
refreshes both sessions and the durable Projects index.

A regenerate or edit-resend truncates the durable transcript before appending
its new user turn. `agent/prompt` accepts `truncateFromMessageId` — the identity
of the first message to drop — which the host resolves against its own
transcript; an unresolvable id is rejected with `NOT_FOUND` rather than cutting
at a guessed position. The older `truncateBefore` count remains accepted, but it
is only correct when the caller holds the entire history: a renderer showing a
bounded window addresses different messages than the transcript does.

`session/fork` is a protocol-v5 channel that creates an independent
session from the source session's current active transcript. When optional
`throughMessageId` is present, the copied snapshot ends at that message; an
unknown id returns `NOT_FOUND`. Electron rejects
the request with `AGENT_BUSY` while that source session has an active turn.
Electron owns localization and supplies the user-facing branch title; the host
fallback title is reserved for non-UI callers.
The host assigns a new session id, message ids, and tool-call ids; it copies
the durable project/provider/model/mode/thinking/permission configuration but
does not copy turns, notifications, artifacts, scratch data, permission
grants, or regenerate revisions. The source session remains unchanged.
Message-scoped assistant Fork/Edit uses this option so the child receives a
new session id and therefore cannot reuse or mutate the source pi runtime or
its provider cache.

Protocol version 9 adds the checkpoint Plan contract: `SubmitPlan`, unique
`.pi/plan/*.md` artifact metadata, approve/reject-only responses, absolute
expiry, `plan_approvals` execution fields, shell catalog/identity fields, and
streamed stdout/stderr events. A v7 or older host, and any incompatible v8
peer, must fail the handshake so a desktop cannot display Plan while silently
losing the artifact, queue, shell, or policy boundary.
`pi-desktop/agent/compact` and `session.appendCompaction` remain part of the v9
contract. The Goal contract is additive inside v9 (**D198**): `kind` is optional
on the wire and absent means `plan`, so a peer that predates Goal keeps working
and simply never negotiates one.

Protocol version 2 adds `thinkingLevel`, `UiMessage.thinking`, and
`message_update.deltaThinking`. A v1 peer must fail the version check instead
of silently discarding these fields.

`UiMessage.error` is an optional additive field. Provider failures attach the
same normalized `AppError` carried by the lifecycle `error` event to the
assistant message before `message_end`. Error messages persist with the
transcript but are excluded from restored model context.

The context inspector consumes two additive usage signals. `MessageUsage` is
the provider-reported assistant usage and `responseDurationMs` is the elapsed
sidecar stream time used to display output tokens per second. `ToolTokenUsage`
is a runtime estimate from the tool call arguments and result; providers do not
report per-tool allocation, so the renderer labels these rows as estimates and
never merges them into the exact provider total. Older peers may omit all of
these optional fields without breaking the v6 handshake.

## 8. Settings / Secrets API

### settings
Non-sensitive config that can be returned to the UI:

- provider list (without secret plaintext)
- default model
- persisted `defaultCommandShell` from the host shell catalog
- persisted `largePasteThreshold` for oversized text-only composer pastes;
  host reads missing values as 600 and accepts integers from 1 through 1,000,000
- permission policy toggles
- UI preferences, including optional `AppSettings.keybindings` overrides keyed
  by the shared shortcut action ids; values use portable `Mod+Shift+Key`
  notation and contain no platform-specific native accelerator strings
- optional `AppSettings.developerMode`; absent and `false` both keep developer
  tools disabled

`settings.set` accepts a partial settings object. Host-core merges supplied
fields into the stored app settings, so omitted fields, including
`defaultCommandShell`, are preserved. Only an incoming shell field is shell
validated; the idle Plan/configuration gate runs only when its effective shell
would change. Unrelated writes and idempotent writes of the current effective
shell remain accepted while work is active. Legacy
`planApprovalPermissionMode` is ignored and stripped from current reads and
writes; it is not exposed or recreated.

### shell

```ts
type CommandShellId = "windows-powershell" | "cmd" | "git-bash" | "bash";

type CommandShellOption = {
  id: CommandShellId;
  label: string;
  dialect: "powershell" | "cmd" | "posix";
  available: boolean;
  isDefault: boolean;
};

type CommandShellCatalog = {
  configuredId: CommandShellId | null;
  effective: CommandShellOption | null;
  fallback: boolean;
  choices: CommandShellOption[];
};
```

Preload methods:

- `pi-desktop/commandShell/list() -> CommandShellCatalog`
- `pi-desktop/settings/set({ defaultCommandShell }) -> { ok: true }`

Settings shell writes accept only an available ID for the current platform and
reject unknown, unavailable, or wrong-platform IDs. A genuine effective shell
change is accepted only while all sessions and Plan/Goal work are idle. If a
persisted ID later becomes unavailable, the catalog selects the first available
platform shell and sets `fallback: true`; if no choice is available, Bash
returns `SHELL_NOT_FOUND`.
Each turn pins the effective ID and dialect. The runtime transports both values;
host rejects a changed pin before permission evaluation and before spawn with
`COMMAND_SHELL_CHANGED`.

### secrets
- `secrets/set(providerId, apiKey)`
- `secrets/delete(providerId)`
- `secrets/has(providerId) -> boolean`

Forbidden:
- Writing the full API key into ordinary logs
- Holding API key plaintext long-term in the renderer

### vendor accounts (OAuth, D237/D240)

Signing in with a vendor subscription is an Electron-main conversation, so it
uses IPC only — the host protocol version is unchanged. Five invoke channels
plus one event channel:

- `pi-desktop/providers/oauth/vendors() -> { vendors: OAuthVendor[] }`
- `pi-desktop/providers/oauth/start({ vendorId }) -> { loginId }`
- `pi-desktop/providers/oauth/respond({ loginId, promptId, value? })` — an
  absent `value` cancels that prompt, which aborts the flow
- `pi-desktop/providers/oauth/cancel({ loginId }) -> { ok: boolean }`
- `pi-desktop/providers/oauth/delete({ providerId }) -> { ok: true }` deletes
  one OAuth account's provider row and its scoped credential
- `pi-desktop/providers/oauth/event` streams `OAuthLoginEvent`

```ts
type OAuthLoginEvent = { loginId: string; vendorId: string } & (
  | { kind: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { kind: "authUrl"; url: string; instructions?: string; opened: boolean }
  | { kind: "deviceCode"; userCode: string; verificationUri: string;
      intervalSeconds?: number; expiresInSeconds?: number }
  | { kind: "progress"; message: string }
  | { kind: "prompt"; request: OAuthPromptRequest }
  | { kind: "promptCancelled"; promptId: string }
  | { kind: "done"; providerId: string; accountLabel?: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled" }
);
```

A flow may raise its first event before `start` has replied — OpenAI Codex
asks browser-or-device-code in the same tick the login begins — so the renderer
must subscribe to the event channel *before* it invokes `start`, hold what
arrives while `loginId` is unknown, and release the matching events in order
once the reply lands. Subscribing after the reply drops that first prompt and
the flow waits forever on a question nobody was shown.

`start` must also be called exactly once per attempt, from a user action rather
than from a React effect — StrictMode runs an effect twice on mount, and a
second attempt opens a second browser and contends for the same local callback
port. The renderer's session object keeps every event it has delivered and
replays it to a later subscriber, so a dialog may mount, unmount and mount
again without restarting anything. Main defends the same invariant from its
side: a `start` for a vendor whose attempt is still in flight cancels that
attempt and waits for it to unwind before beginning the next one.

Every flow shape — browser callback, device code, a pasted code, a vendor
choice — travels this one stream, so the renderer renders what arrived instead
of branching per vendor. `opened: false` means the browser could not be
launched and the user must copy the link. `promptCancelled` means the flow
answered a question itself (a callback that beat the paste box), so the input
must disappear on its own.

Forbidden here as well: no event carries a token, a refresh token, or an
authorization code. `accountLabel` is a display string.

## 9. Project API

- `project/open()`: system directory picker
- `project/openFolder(path)`: open a known project directory in the system file
  manager
- `project/get()`: current workspace
- `project/list()`: durable project records, including import-created entries
- `project/set(path)`: set workspace
- `project/clear()`

Returns:

```ts
type ProjectWorkspace = {
 path: string;
 name: string;
};

type ProjectRecord = {
 id: number;
 path: string;
 name: string;
 pinned: boolean;
 createdAt: number;
 lastOpenedAt: number;
};
```

## 10. Tool Permission API

When a tool requires confirmation:

1. main sends `tool_permission_request`
2. UI shows a confirmation card
3. UI calls `tool/resolvePermission`

```ts
type ToolPermissionRequest = {
 requestId: string;
 sessionId: string;
 toolCallId: string;
 toolName: string;
 argsPreview: unknown;
 risk: "low" | "medium" | "high";
 reason: string;
 /** Definition name when a subagent asked (D201, ADR 0062); absent for the
  * session's own calls, together with the `Task` call that spawned it. */
 agentName?: string;
 parentToolCallId?: string;
};

type ToolPermissionResolution = {
 requestId: string;
 decision: "allow-once" | "allow-session" | "deny";
};
```

A session can hold more than one open request once it runs parallel subagents.
The renderer queues them per session and answers the oldest first; the resolution
contract is unchanged, because it was already keyed by `requestId`
(`04-ux/03-permission-ux.md` §6a).

Plan does not replace this generic permission contract. A Plan `Bash` call
uses the normal session-scoped permission flow: `ask` and `accept-edits` emit a
tool permission request, while `auto` executes without confirmation. Plan
approval is a separate state transition and always uses the `plan` methods
above.

## 11. Version Compatibility

- IPC/host contract version field: `protocolVersion: 9`
- Breaking changes must bump the version and record an ADR
- renderer and main validate the version at startup; on mismatch, prompt to upgrade/reinstall
- Protocol v4 adds notification records, channels, and the
  notification-bearing `session.endTurn` result. A v3 peer is rejected rather
  than silently losing durable completion/failure events.
- The optional viewing-session invoke and `createNotification` end-turn field
  are additive v4 behavior. Older callers omit the field and retain the
  fail-safe default of creating notifications.
- Protocol v5 adds the required `session/fork` snapshot operation. A v4 peer is
  rejected before chat becomes interactive instead of exposing a branch
  command that can only fail at invocation time (ADR 0023).
- Protocol v6 added durable context checkpoints plus the manual/lifecycle
  channels. A v5 peer is rejected because silently omitting a checkpoint can
  make the next provider request unsafe (ADR 0030).
- Protocol v9 supersedes the earlier v7 Plan contract. It adds `SubmitPlan`,
  exact unique artifact metadata, approve/reject-only resolution, 30-minute
  absolute expiry, `plan_approvals` execution states, shell selection and
  pinned ID/dialect, and streamed command output. A v7/v8 peer is rejected
  before the UI becomes interactive because it cannot enforce or represent this
  boundary (ADR 0053/0054). `SubmitGoal` and the optional `kind` discriminator
  ride along inside v9 and need no version bump, because an absent `kind` is
  exactly the pre-Goal behavior.

## 12. Plugin API (host UI side)

Minimal interface:

- `plugin/list`
- `plugin/loadDev(path)`
- `plugin/reload(id)` — reload a registered development plugin from its stored
  path and refresh its permission ceiling
- `plugin/installFromPath(path)`
- `plugin/enable(id)`
- `plugin/disable(id)`
- `plugin/uninstall(id)`
- `plugin/getPermissions(id)`
- `plugin/setPermission(id, permission, allowed)` (optional fine-grained)
- `plugin/setScope(id, scope)` (D192)

Returned summary:

```ts
type PluginSummary = {
 id: string
 name: string
 version: string
 enabled: boolean
 source: "installed" | "dev"
 status: "ready" | "error" | "disabled"
 errorMessage?: string
 permissions: string[]
 scope?: ActivationScope
}
```

## 12a. User MCP server API (D193)

User-owned MCP configuration is stored as one JSON file per id under
`~/.agents/servers/<id>.json` or `<project>/.agents/servers/<id>.json`.
Enablement is not written to those files; host-core stores it in the
application-local `<data>/agent-capabilities/mcp.json` state file.

- `mcp.list({ level, projectPath? })` → `{ servers: McpServerRecord[]; statuses: McpServerStatus[] }`
- `mcp.active({ projectPath? })` → the effective runtime list
- `mcp.upsert(server)` — creates or replaces the file at the requested level
- `mcp.remove({ id, level, projectPath? })`
- `mcp.setEnabled({ id, enabled, level, projectPath? })`
- `mcp.setScope` remains a compatibility-shaped call; the Settings page uses
  the explicit capability level and local state instead

A project-level request without `projectPath` is invalid. `mcp.active` removes
project records from the global set by id or case-insensitive label before it
filters disabled records, so a disabled project record still shadows a global
one. The desktop-only `mcp/test` IPC action forces one connection test and
returns its status to the MCP editor.

```ts
type McpServerStatus = {
 serverId: string
 state: "idle" | "connecting" | "ready" | "failed"
 toolCount: number
 toolNames?: string[]
 message?: string
 updatedAt: number
}
```

Tools reach the agent as `mcp_<serverId>_<toolName>`, disjoint from the plugin
bridge's `plugin_` namespace (D015).

## 12b. User skill API (D194)

User skills are Markdown documents scanned from `~/.agents/skills` and
`<project>/.agents/skills`. Both direct Markdown files and the conventional
`<skill>/SKILL.md` shape are accepted. Enablement is stored in
`<data>/agent-capabilities/skills.json`, never in the document.

- `skills.list({ level, projectPath? })` → `{ skills: UserSkillRecord[] }`
- `skills.active({ projectPath? })` → the effective runtime list
- `skills.create(skill)`
- `skills.import({ path, level, projectPath? })` — one source file is physically
  copied into the selected `.agents/skills` directory
- `skills.update({ id, ...skill })`
- `skills.read({ id, level?, projectPath? })` → `{ skill, body }`
- `skills.remove({ id, level?, projectPath? })`
- `skills.setEnabled({ id, enabled, level, projectPath? })`

The list contains frontmatter-derived `name` and `description`, not the body.
Only the description enters the prompt, and the body is fetched when the model
invokes `Skill` (D174). A missing file is removed from the list and its local
state is pruned during the next scan.

## 12c. Subagent API (D202)

User-owned subagents are global-only Markdown documents under
`~/.agents/subagents/<id>.md`. There is no project-level subagent directory.
Enablement is stored in `<data>/agent-capabilities/subagents.json` and is never
written into the Markdown file.

- `agents.list` → `{ subagents: UserSubagentRecord[] }`
- `agents.active` → enabled global documents
- `agents.create(subagent)` — duplicate names fail with `SUBAGENT_INVALID`
- `agents.update(id, subagent)`
- `agents.read(id)` → `{ subagent, body }`
- `agents.remove(id)`
- `agents.setEnabled(id, enabled)`

Electron's `subagent/list` IPC channel exposes the same global-only list to
Settings > Agent > Subagents. The runtime catalog combines these global user
documents with its builtins; it does not scan `.pi/agents` or any project
capability directory.

## 12d. Capability level and local activation

Skills and MCP management calls use:

```ts
type AgentCapabilityQuery = {
 level: "global" | "project"
 projectPath?: string
}
```

Global records default to enabled and may have a per-project override. Project
records have state for their owning project. The host prunes state for deleted
files while scanning; deleting a global file removes all of its project
overrides. These records are independent from plugin `ActivationScope`.

## 13. Command Palette API

- `commandPalette/search(query)`
- `commandPalette/execute(commandId)`

Command sources:
- Built-in commands
- Plugin contributes.commands

## 13a. Work Panel APIs

Work panel channels are Electron-main implementations. User-driven workspace
operations resolve the visible root from `workspace.get` and fail closed
without one. Agent-driven BrowserPreview routing resolves the originating
conversation through `session.get`, so a background preview never inherits the
visible session's workspace.

### workspace

- `workspace/diff()` → `WorkspaceDiff { repo, clean, files: DiffFile[], truncated? }`.
  This legacy diagnostics channel may inspect the current working tree, but it
  is not the Review source of truth. The Review UI reads message-owned review
  records from transcript tool results instead, so a commit cannot erase a
  recorded change.
- `workspace/review/rollback({sessionId, snapshotId})` →
  `ReviewRollbackResult`. The host verifies the current post-tool hash before
  restoring the snapshot; it returns `rolledBack`, `alreadyRolledBack`,
  `conflict`, or `unavailable` and never overwrites a conflicting later edit.

### browser (D100)

- `browser/navigate({url, sessionId?})` (scheme-normalized; http/https work
  without a workspace, while a local path requires the supplied session's
  durable project root or the visible workspace for legacy calls),
  `browser/action({action: back|forward|reload|stop})`,
  `browser/setBounds({x,y,width,height})` (renderer-measured content rect),
  `browser/setVisible({visible})`, `browser/openExternal()`,
  `browser/getState()`
- event: `browser/event/state {url, title, isLoading, canGoBack, canGoForward}`
- agent preview event: `browser/event/preview {sessionId, path}`. Electron Main
  validates `path` inside that session's project before emitting; the renderer
  records it in the matching runtime panel context and navigates only when that
  conversation is visible.

### fs (read-only)

- `fs/list({path})` → entries sorted dirs-first; ignores `.git`,
  `node_modules`, and the default ignore subset of
  [15-workspace-ignore-rules](15-workspace-ignore-rules.md)
- `fs/read({path})` → text (≤512KB) / image data URL (≤5MB) / binary / tooLarge
- `fs/reveal({path})` → reveal in Finder
- Every path resolves inside the workspace root; traversal outside is
  rejected (`INVALID_ARGUMENT`).

## 13b. Desktop Menu and Window APIs

The preload exposes a synchronous, read-only `platform: NodeJS.Platform`
value so the renderer chooses native macOS chrome or menu-free Windows/Linux
frameless chrome before first paint.

Main-to-renderer application commands use one allowlisted event:

```ts
type AppMenuCommand =
  | "newTask" | "openProject" | "openSettings"
  | "openCommandPalette" | "toggleSidebar"
  | "openHelp" | "openLogs" | "checkForUpdates";

event: menu/event/command { command: AppMenuCommand }

menu/rendererReady() -> { ready: true }
```

The renderer subscribes to `menu/event/command` before invoking
`menu/rendererReady`. Main waits for that acknowledgement when a native menu
command creates or reloads a window, so startup timing cannot drop the first
command.

Renderer-owned Windows/Linux keyboard shortcuts execute zoom and fullscreen
operations through `menu/nativeAction`. The retained compatibility surface
also supports editing and window operations. Its request is restricted to the
exported `NATIVE_MENU_ACTIONS` tuple; unknown values fail rather than becoming
a generic main-process command surface:

```ts
type NativeMenuAction =
  | "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll"
  | "reload" | "zoomIn" | "zoomOut" | "resetZoom"
  | "toggleFullScreen" | "minimize" | "toggleMaximize" | "close";

menu/nativeAction({ action: NativeMenuAction })
  -> { maximized: boolean; fullScreen: boolean }
```

Developer tools use a dedicated Main-owned gate rather than a generic native
menu action:

```ts
devtools/toggle({ open?: boolean }) -> { open: boolean }
```

Main rejects the request while `AppSettings.developerMode` is not `true` or no
live window exists. The same stored flag gates F12 on all platforms,
Ctrl+Shift+I on Windows/Linux, and the macOS View-menu role. Disabling the flag
closes an already-open developer-tools window.

`window/control` accepts the exported `WINDOW_CONTROL_ACTIONS` tuple:

```ts
type WindowControlAction =
  | "getState" | "minimize" | "toggleMaximize" | "close";

window/control({ action: WindowControlAction })
  -> { maximized: boolean }
```

On Windows/Linux, `minimize` performs the native OS minimize transition so
the window remains represented in the taskbar and can be restored there. A
Windows/Linux close still follows the persisted close-behavior choice below;
it is the close path, not minimize, that can hide the window to the tray.
macOS keeps its native Dock/tray minimize behavior.

Windows/Linux close behavior (D230, ADR 0090) is read and written through
two additive Main-owned channels. `closeBehavior/get` returns the persisted
preference and whether the platform supports it (macOS keeps the native
Dock lifecycle and reports `supported: false`); `closeBehavior/set`
accepts a settable `CloseBehavior` (`tray` or `quit`) and persists it:

```ts
type CloseBehavior = "ask" | "tray" | "quit";

window/closeBehavior/get -> { behavior: CloseBehavior; supported: boolean }
window/closeBehavior/set({ behavior: "tray" | "quit" })
  -> { behavior: "tray" | "quit" }
```

`ask` is the transient unset state reported by `get`; it is never settable
— the first close prompts once, and once a choice exists it can be switched
but not reverted to prompting. `ask` and unknown values fail with
`INVALID_ARGUMENT` rather than being coerced, and `set` fails the same way on
macOS, where there is no close behavior to configure. Setting a behavior does
not touch the tray icon: D216 (ADR 0078) creates one at startup on every
platform, and minimize-to-tray needs it whichever close behavior is stored.

Maximize/unmaximize changes also emit
`window/event/maximized`. Unknown actions fail. These Electron-only channels
do not cross into host-core and do not change the host RPC protocol version.
The preload intentionally exposes no arbitrary BrowserWindow resize channel.
Plugin panel chrome uses a separate Electron-local
`pi-plugin-panel-window-control` channel with the same four semantic actions,
but the handler resolves the target strictly from the sender's live panel
window. The preload consumes this channel internally for its closed-Shadow-DOM
titlebar; it is not added to `window.pluginBridge` or the shared host protocol.
The one geometry-specific capability is a target-state work-panel reservation
(D163, D255, ADR 0032/0122):

```ts
window/setWorkPanelReservation({ width: 0 | number })
  -> { requested: number; reserved: number }
```

`width` must be a finite integer JSON number equal to `0` or inside the
inclusive `244..720` range. Strings, booleans, null, fractional values, and
other malformed payloads fail with `INVALID_ARGUMENT` rather than being
coerced. Zero is the closed/collapsed target, and a positive value is the
visible panel's committed fixed width. `requested` is the accepted current target.
`reserved` is the native width currently added
to the normal base window for that target and can be smaller than `requested`
only when the display work area is insufficient. Calls are idempotent target
updates: repeating the same width never adds another delta.

In normal state, Main expands the base bounds toward the right and shifts left
only as needed to keep the expanded bounds inside the current display work
area. A zero target symmetrically removes the added width and reverses that
reservation-induced shift. Main persists base bounds with both effects removed.
Native edge gestures update only those base bounds, leaving `requested` and the
renderer-owned fixed panel width unchanged. Maximized and fullscreen windows
remember the latest target but defer geometry; returning to normal reconciles
it once against the restored base bounds and current work area. If the window
manager first compresses or relocates the outer window during a display or
work-area transition, reconciliation preserves the last confirmed base bounds;
returning to a roomier work area restores the original chat width. That
preservation applies to window-manager adjustments only. A cross-display change
that arrives while the user is dragging the window is attributed to the user
(D263, ADR 0132): the dropped position becomes the new base bounds, with only
its origin normalized into the target display work area, and it is the position
persisted for relaunch. The base size is preserved even when the target work
area is narrower, so `reserved` shrinks rather than the window. Main defers this
reconciliation until the native move stream settles, so no reservation geometry
is applied mid-drag. Renderer code
sets this target only for the currently visible session: background artifacts
cannot change visible reservation geometry.

## 13c. Composer input APIs (D123/D124/D197, ADR 0024/0059)

Electron-only channels backing composer autocomplete and clipboard file
references. `composer/commands` and `fs/index` are read-only and fail soft;
`composer/pasteFiles` writes only to the originating session's Electron-owned
scratch directory. None adds a host RPC method or changes the host protocol
version.

### composer/commands

```ts
composer/commands() -> { commands: ComposerCommand[] }

type ComposerCommand = {
  /** Slash name typed after "/", unique across the merged list. */
  name: string;
  kind: "template" | "builtin" | "plugin";
  title: string;            // display title (templates: name)
  description?: string;     // template frontmatter / palette title
  argumentHint?: string;    // template frontmatter `argument-hint`
  source?: "project" | "user"; // template provenance
  id?: string;              // builtin/plugin palette id for execution
};
```

Templates load from `<workspace>/.pi/prompts/*.md` and
`~/.pi/agent/prompts/*.md` (project wins name conflicts; short TTL cache).
Without a workspace only user-global templates, builtins, and plugin
commands return.

### fs/index

```ts
fs/index() -> { entries: FsIndexEntry[]; truncated: boolean }

type FsIndexEntry = { path: string; kind: "file" | "dir" };
```

Workspace-rooted relative paths for the `@` menu: `git ls-files -co
--exclude-standard` fast path, ignore-set recursive walk fallback,
directories derived from file paths, 8000-entry cap with `truncated: true`,
short TTL cache per root. Fails closed to an empty list without a
workspace. Fuzzy filtering happens renderer-side.

### composer/pasteFiles

```ts
composer/pasteFiles({ sessionId, files }) -> {
  files: ComposerPastedFile[];
}

type ComposerPasteFile = {
  name?: string;
  mimeType?: string;
  data: ArrayBuffer;
};

type ComposerPastedFile = {
  path: string;     // UUID-backed absolute storage path
  name: string;     // sanitized original leaf display name
  kind: "image" | "file";
  mimeType: string;
  size: number;
};
```

Electron main verifies that `sessionId` resolves to a durable host session,
limits the request to 20 files, 64 MiB per file, and 128 MiB total, strips
renderer-provided directory components, and writes unique names below
`<data_dir>/scratch/<sessionId>/pasted/` with exclusive-create semantics. The
renderer holds returned paths and kind metadata in transient reference state,
displays `name`, and submits them through `AgentPromptRequest.attachments`.
Main persists image bytes by SHA-256 and adds a path fallback only when the
selected model cannot receive that image as a visual block. Clipboard bytes
never enter the persisted prompt or host agent message as base64.
Invalid sessions and malformed/oversized payloads fail with an IPC error, and
the operation cannot write to the workspace.

### prompt/enhance

```ts
prompt/enhance({
  sessionId?: string | null;
  draft: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}) -> { enhancedDraft: string }
```

This is an independent, one-shot completion with no session history, tools, or
attachments. Electron main resolves the provider/model and credentials, so the
renderer never receives a secret. Empty drafts, slash-command drafts, missing
models, and provider failures return the common `Result` error envelope.

## 14. Error Codes — Initial registry (extensible)

| code | Meaning |
|---|---|
| `AGENT_BUSY` | The current session already has a running turn |
| `AGENT_NOT_FOUND` | Session does not exist |
| `MODEL_NOT_CONFIGURED` | No available model |
| `PROVIDER_SECRET_MISSING` | Missing API key |
| `TOOL_DENIED` | Permission denied |
| `TOOL_TIMEOUT` | Tool timed out |
| `WORKSPACE_REQUIRED` | Project directory required |
| `PATH_OUTSIDE_WORKSPACE` | Path out of bounds before an explicit outside-path permission decision |
| `INTERNAL` | Uncategorized internal error |
