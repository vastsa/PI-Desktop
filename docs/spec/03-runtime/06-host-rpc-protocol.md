# 06. Host RPC Protocol

## 1. Goal

Define the local protocol between:

- Electron main (orchestrator)
- Rust host-core (privileged backend)
- Node pi agent sidecar (tool requester / event source consumer via host)

MVP transport decision (**D001**):

> **stdio JSON-RPC over NDJSON**

## 2. Transport

- Process: Electron main spawns Rust host-core sidecar
- Channel: child process stdin/stdout
- Framing: one JSON object per line (NDJSON)
- Encoding: UTF-8
- Request/response: JSON-RPC 2.0 style

The control pipe is resource-isolated inside host-core. One dedicated OS
thread reads stdin and one dedicated OS thread serializes stdout; request and
tool tasks never perform Tokio stdio operations. This keeps temporary OS
thread exhaustion from turning a pipe read/write into a Tokio blocking-pool
panic. The threads retry interrupted and transient nonblocking errors while
preserving one-message-per-line framing; an unrecoverable pipe error ends the
host and is handled by the normal Electron supervision path.

### 2.1 Runtime admission and backpressure

Host-core does not create an unbounded task or subprocess for every request.
The RPC dispatcher caps active requests at 32. `tools.execute` then enters a
bounded execution budget:

- 16 total tool executions
- 4 concurrent `Bash` processes globally, 2 per session
- 8 read/search tools globally
- 2 mutating tools globally, 1 per session
- 4 plugin tools globally
- 4 tool executions per session
- 64 queued tool executions globally

Permission prompts do not consume an execution slot. A full queue returns
`HOST_OVERLOADED` with retryable semantics in the tool result instead of
waiting indefinitely or spawning more work. The limits are host-owned so
Electron and the sidecar cannot independently over-admit the same resources.
The per-session mutation permit is acquired before the global mutation slot;
queued `Write`/`Edit` calls therefore do not hold global capacity while waiting
for an earlier mutation in the same session.

Electron's `HostProcess` treats an explicit `HOST_OVERLOADED` response as
retryable backpressure for renderer-facing calls. It waits 50, 100, 200, and
400 ms between at most four retries, then returns the structured error to the
caller. This retry applies only to an admission rejection; transport failure,
timeout, and errors from an admitted request are never replayed.

### Request

```json
{
  "jsonrpc": "2.0",
  "id": "req_01H...",
  "method": "tools.execute",
  "params": {}
}
```

### Response

```json
{
  "jsonrpc": "2.0",
  "id": "req_01H...",
  "result": {}
}
```

### Error

```json
{
  "jsonrpc": "2.0",
  "id": "req_01H...",
  "error": {
    "code": 1003,
    "message": "PATH_OUTSIDE_WORKSPACE",
    "data": {
      "errorCode": "PATH_OUTSIDE_WORKSPACE",
      "details": {}
    }
  }
}
```

### Notification (server → client, no id)

```json
{
  "jsonrpc": "2.0",
  "method": "permissions.request",
  "params": {}
}
```

## 3. Handshake

On spawn, Electron must call:

### `app.handshake`

Params:

```ts
type HandshakeParams = {
  protocolVersion: 9
  client: "electron-main"
  clientVersion: string
  locale: string // default "en"
}
```

Result:

```ts
type HandshakeResult = {
  protocolVersion: 9
  host: "rust-host-core"
  hostVersion: string
  features: string[]
}
```

Rules:

1. If protocol major version mismatches → abort boot
2. Electron should exit with actionable error if handshake fails
3. All subsequent calls require successful handshake
4. Version 4 introduced the durable notification inbox and the
   notification-bearing `session.endTurn` result.
5. Version 5 requires the host-owned `session.fork` snapshot operation; a
   version 4 host must be rejected before chat becomes interactive (ADR 0023).
6. Version 6 adds durable model-context checkpoints through
   `session.appendCompaction`; a version 5 host must be rejected before the
   runtime claims automatic context protection (ADR 0030).
7. Version 9 is the frozen ADR 0053/0054 contract: it covers the checkpoint
   Plan artifact/queue, active-turn Plan identity/CAS, explicit approval
   permission, shell catalog identity and dialect pin, streamed command output,
   and scheduled-task mode projection from `config_json`. A v7 or incompatible
   v8 host must be rejected before the UI becomes interactive.

Protocol v9 remains paired with host-core storage schema v11 (v11 adds the
`plan_approvals.kind` discriminator). The schema version
is an internal persistence invariant, not an additional JSON-RPC field; the
checkpoint architecture remains host-owned.

## 4. Method catalog (MVP)

### App
- `app.handshake`
- `app.health`
- `app.getVersion`

`app.health` returns a diagnostic `toolBudget` object:

```ts
type ToolBudgetHealth = {
  active: number
  queued: number
  total: number
  shell: number
  reads: number
  mutations: number
  plugins: number
}
```

### Workspace
- `workspace.get`
- `workspace.set`
- `workspace.clear`

### Review snapshots (ADR 0043)
- `review.rollback({sessionId, snapshotId})` — verify the current post-tool
  hash, restore the session-owned previous bytes, and return one of
  `rolledBack`, `alreadyRolledBack`, `conflict`, or `unavailable`.

### Projects
- `projects.list` — returns durable project records ordered pinned-first, then
  by last-opened time; includes records materialized by session imports

### Secrets
- `secrets.set`
- `secrets.delete`
- `secrets.has`
- `secrets.getForRuntime` — main/host only, never reachable from the renderer
- // never `secrets.get` to renderer logs

A provider row has two independent refs — `secret:provider:<id>:api_key` and
`secret:provider:<id>:oauth` (D237/D240). The generic methods above serve both, so a
vendor-account credential needed no new host method. `ProviderPublic` therefore
reports `hasSecret` (true for **either** credential), `hasOauth`, and the
non-secret `oauthAccountLabel`; `providers.create` / `providers.update` accept
`oauthAccountLabel`, and `providers.delete` clears both refs for exactly one
row. Login orchestration and token refresh stay in Electron main and never
reach this protocol — see [14-secrets-storage](14-secrets-storage.md) §10.

### Settings
- `settings.get`
- `settings.set`

### Sessions
- `session.list` — returns summaries with host-authoritative `messageCount`
  alongside the existing session metadata
- `session.create` — accepts optional `thinkingLevel`; missing/null defaults
  to `off`
- `session.fork` — accepts `sessionId`, an optional caller-provided display
  `title`, and optional `throughMessageId`; creates
  one independent session from the source's current active canonical
  transcript, truncated inclusively at the selected message when supplied.
  The child inherits project/provider/model/mode/thinking and
  permission configuration, receives new message/tool-call ids, and starts
  without turns, revisions, notifications, artifacts, grants, or scratch data.
  Missing sources return `NOT_FOUND`; Electron rejects active sources with
  `AGENT_BUSY` before forwarding and normalizes the host's persisted
  running-turn `CONFLICT` fallback to `AGENT_BUSY`; an unknown source or
  `throughMessageId` returns `NOT_FOUND`
- `session.get` — accepts an optional renderer read window:
  `messageBefore` is the exclusive zero-based end offset, `messageLimit` is
  the positive page size, and `contentLimit` is the positive character budget
  for the derived display projection. The response includes
  `messageStart` and `hasMoreBefore` when a window is requested. Omitting all
  three options returns the complete lossless UI projection for sidecar and
  mutation callers. Window offsets are physical transcript message-line
  positions, clamped against the cached transcript layout rather than the
  deduplicated session index counter, and a window is served by seeking to its
  first selected line instead of scanning the history before it.
- `session.delete`
- `session.rename`
- `session.configure` — atomically persists `mode`, `providerId`, `modelId`,
  and optional `thinkingLevel` for the next pi turn; omitting/null
  `thinkingLevel` preserves the current value; invalid modes or levels return
  `INVALID_PARAMS`; mode is `plan | goal | agent` and changing any session
  configuration is allowed only while idle and without a pending/queued/running
  Plan or Goal record
- `session.appendMessage`
- `session.appendCompaction` — sidecar-only append of the newest typed
  model-context checkpoint. It requires non-empty checkpoint/summary/boundary
  ids and non-negative `tokensBefore`; it does not insert a message/search row
  or change the visible transcript projection
- `session.replaceMessages` — atomic transcript rewrite (temp-file rename +
  one index transaction, D119) used by regenerate/edit flows and unanswered
  renderer smart-stop undo; it preserves the
  newest checkpoint only while both its boundary and optional first-kept id
  remain valid in the rewritten prefix, and it carries each surviving message's
  owning `turn_id` across the rewrite. It is only safe from a caller that owns
  the whole transcript for the duration of the call: any rewrite from a snapshot
  taken outside the RPC lock can delete a message appended in between
- `session.saveRevision` — archive a regenerate branch under
  `(sessionId, rootUserId)`
- `session.saveActiveRevision` — archive the branch of the newest
  revision-bearing user root as its active revision and stamp that root's pager
  metadata, all under the RPC lock. The stamp rewrites one transcript line
  instead of the file, so a concurrent `session.appendMessage` survives.
  Returns `{ saved: null }` when the session owns no regenerate history.
  Turn-completion callers use this instead of
  `session.get` + `session.replaceMessages`
- `session.listRevisions` — list linear variants for a root user family
- `session.activateRevision` — replace live transcript with `prefix + branch`
  and stamp root pager metadata
- `session.beginTurn`
- `session.endTurn` — atomically moves a running turn to its terminal state and
  conditionally returns the newly created notification for `completed`/`error`;
  returns no notification when `createNotification=false`, for `aborted`, or
  for an already-terminal turn
- `session.import` — atomically imports one converted session; a non-empty
  project path is normalized and upserted into `projects` before the session
  references it; returns `{ imported, skipped }`

### Plan and Goal state and approvals

Both contract kinds share these methods; the optional `kind`
(`plan | goal`, default `plan` so a pre-D198 sidecar still works) selects which
contract is being negotiated.

- `plans.enter` — accepts only the active Agent turn's `sessionId`, `turnId`,
  and `toolCallId` plus the `kind`; host-core performs the mode transition to
  that kind's mode with a compare-and-swap update and emits `plans.changed`
  carrying the `kind`. An unrecognized `kind` fails with `INVALID_PARAMS`
- `plans.submit` — writes the host-owned artifact under the kind's directory and
  creates a pending proposal whose `kind` is persisted on the row
- `plans.pending` — returns only pending approval rows, the session planning
  state, and the `kind` of the contract being negotiated (the pending row's kind,
  falling back to the session's own contract mode); renderer reload does not
  extend the absolute deadline while the host remains alive and does not restore
  terminal cards
- `plans.resolve` — validates one matching approve/reject response and, for
  approval, commits the selected permission mode and `execution_state = queued`
- `plans.queuedExecutions` / `plans.claimExecution` /
  `plans.finishExecution` — consume and transition execution fields on the
  same approval row; the claimed execution reports its `kind` so the sidecar can
  select the matching execution instruction
- `plans.abort` — marks pending approval work interrupted; it never replays or
  changes an already-approved session back to its contract mode

### Scheduled tasks

- `scheduled.list` / `scheduled.create` / `scheduled.update` /
  `scheduled.delete`
- `scheduled.import` — imports task records and normalizes their persisted mode
- `scheduled.run` / `scheduled.finishRun` / `scheduled.listRuns`

The wire `ScheduledTask.mode` is a normalized projection of the durable
`config_json.mode`; create, update, and import map legacy `chat` to `plan` and
default missing values to `agent`. `scheduled.run` reads the selected task's
persisted mode; a `plan` or `goal` task fails with
`PLAN_REQUIRES_INTERACTIVE_SESSION` before creating a session or run. It never
uses `settings.defaultMode` as the task mode.

Canonical thinking levels at the host boundary are:

```text
off | minimal | low | medium | high | xhigh | max
```

Session summaries/details always return `thinkingLevel`. Assistant messages
may return `thinking`; host storage maps it to a canonical content block rather
than appending it to answer `content`.

### Tools
- `tools.list`
- `tools.execute`
- `tools.abort`
- `tools.output` notifications for ordered `stdout`/`stderr` chunks

### Shells
- `commandShells.list`
- `settings.set` with a partial settings object; omitted fields are preserved,
  and a changed effective `defaultCommandShell` is accepted only when every
  session has no active turn and no pending/queued/running Plan/Goal work

Tool execution starts only after admission. Shell spawn retries transient
resource exhaustion (`EAGAIN` / `WouldBlock`) with bounded backoff, never
retries a command after it has started, and reaps timed-out children before
releasing the execution slot.

`session.appendMessage` is idempotent by message id. Electron main may keep
message appends in its application-owned outbox while host-core is restarting;
the outbox flushes in order after a successful handshake.

### Permissions
- `permissions.evaluate`
- `permissions.resolve`
- `permissions.listSessionGrants`
- `permissions.clearSessionGrants`

### Plugins
- `plugins.list`
- `plugins.loadDev`
- `plugins.installFromPath`
- `plugins.enable`
- `plugins.disable`
- `plugins.uninstall`
- `plugins.getPermissions`

### Audit
- `audit.append`
- `audit.query` (optional later)

### Notification (D117)
- `notification.list`
- `notification.markRead`
- `notification.markAllRead`
- `notification.clear`

## 4a. Notification contracts (protocol v4)

```ts
type AppNotification = {
  id: string;
  kind: "task.completed" | "task.failed";
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string; // ISO-8601 UTC
  readAt?: string | null;
};

type SessionEndTurnParams = {
  turnId: string;
  status: "completed" | "error" | "aborted";
  errorCode?: string;
  usage?: unknown;
  createNotification?: boolean; // default true; Electron supplies visibility decision
};

type SessionEndTurnResult = {
  ok: boolean; // false when the turn was missing/already terminal
  notification?: AppNotification; // omitted when no row was inserted
};

type NotificationListParams = {
  unreadOnly?: boolean; // default false
  limit?: number;       // default/max 200
};

type NotificationListResult = {
  notifications: AppNotification[]; // newest first
  unreadCount: number;               // global count, independent of filter
};
```

- `notification.markRead({ id }) -> { ok }` is idempotent. `ok=false` means
  the id does not exist; an already-read row remains successful.
- `notification.markAllRead({}) -> { ok: true }` updates every unread row in
  one transaction.
- `notification.clear({}) -> { ok: true }` deletes inbox rows only.
- No `notification.created` JSON-RPC server notification is emitted. Electron
  receives the inserted record directly from `session.endTurn`, avoiding a
  second ordering channel between terminal turn persistence and UI refresh.
- `createNotification=false` suppresses only inbox insertion; the running turn
  still reaches its requested terminal state in the same transaction. Missing
  or non-boolean values default to true so unknown/stale UI state cannot lose a
  notification.
- `sessionTitle` is the stable session-name snapshot stored with the row.
  Localized event title/body prose is derived by Electron/renderer and never
  crosses host RPC.

## 5. Tool execute contract

### `tools.execute` params

```ts
type ToolsExecuteParams = {
  sessionId: string
  turnId?: string
  toolCallId: string
  toolName: string
  args: unknown
  /** Diagnostic/request context only; never used for authorization. */
  requestedMode?: "plan" | "goal" | "agent"
  expectedCommandShellId?: CommandShellId
  /** Bash only: dialect pinned by the same runtime turn. */
  expectedCommandShellDialect?: "powershell" | "cmd" | "posix"
  /** Bash only: host default 60000; accepted override 1000..300000. */
  timeoutMs?: number
}
```

Authoritative mode and workspace resolution are session-scoped:

1. Host loads `sessionId` and resolves its persisted `project_id`/path.
2. Host reads the persisted `sessions.mode` and validates it as `plan | agent`.
   A conflicting `requestedMode` is ignored for authorization and recorded only
   as diagnostic data.
3. That path becomes the tool sandbox root for permission preview, execution,
   artifact paths, and audit context. A tool's explicit `path` may name an
   outside location only after the host applies the outside-path permission
   rule; successful external results retain an absolute canonical path.
4. The mutable `workspace.get` selection is not consulted for a valid durable
   session, so switching a retained project tab cannot redirect a background
   call.
5. A durable path-less session resolves no root and receives
   `WORKSPACE_REQUIRED` where the tool requires one. A selected project is not
   inherited.
6. Legacy calls whose session does not exist may temporarily fall back to the
   selected workspace; new renderer flows must always provide a valid
   `sessionId`.
7. A database/session-resolution error returns `INTERNAL` and fails closed;
   only a confirmed missing session may use the legacy fallback.

For `Read`/`Glob`/`Grep`/`Write`/`Edit`, the host classifies an explicit path
outside the workspace and scratch roots before the low-risk auto-allow rule.
`auto` executes it, while `ask` and `accept-edits` emit
`permissions.request`; denial, timeout, or cancellation returns `TOOL_DENIED`
without executing the operation. Relative `..` and symlink escapes use the
same classification. Bash's working directory and implicit recursive walks do
not inherit this exception.

Before generic permission evaluation, host-core applies the mode policy:

- Plan and Goal allow `Read`, `Glob`, `Grep`, `BrowserPreview`, `Bash`, and the
  kind's submit tool (`SubmitPlan` / `SubmitGoal`) as applicable to the live
  planning state.
- Plan and Goal deny `Write`, `Edit`, every plugin tool, and unknown tools under
  all permission modes and grants. The host reads the session's **durable** mode
  for this check, so a sidecar claiming `agent` in `tools.execute` cannot widen
  it, and the `*_IN_PLAN` error codes are shared by both kinds.
- Plan and Goal `Bash` follows the resolved permission mode: `ask` and
  `accept-edits`
  emit `permissions.request`; `auto` executes without confirmation and may
  mutate. The host re-resolves the effective shell ID/dialect and requires the
  exact `expectedCommandShellId` and `expectedCommandShellDialect` before
  permission evaluation and again before spawn; it streams stdout/stderr
  separately. A configured shell may fall back to the first available platform
  shell before the turn pin is created, but execution never changes shell
  after the pin.
- Agent applies the normal registered-tool and permission policy.

The visible tool list is not the security boundary; a forged RPC call is
authorized by this host-side matrix.

### result

```ts
type ToolsExecuteResult = {
  toolCallId: string
  ok: boolean
  isError?: boolean
  content: unknown
  durationMs: number
  denied?: boolean
  errorCode?: string
  // Workspace Write/Edit results may include content.details.review. The
  // record is persisted with the tool message and is independent of Git.
  // Bash command failures preserve content.exitCode/stdout/stderr while
  // setting ok=false, isError=true, and errorCode=TOOL_FAILED.
  // The agent runtime forwards isError into the tool transcript without
  // dropping the structured content/details needed for recovery.
}
```

### 5.1 Plan and Goal submission and approval contracts

`SubmitPlan` and `SubmitGoal` are handled as host transitions before generic
tool execution. The host preserves the exact Markdown bytes in a new unique
artifact under the kind's directory before publishing the proposal.

```ts
// Identical shape for both kinds; the tool name selects the kind.
type SubmitPlanParams = {
  title: string;
  markdown: string;
  question: string;
};

type ProposalKind = "plan" | "goal";

type PlanningState = "inactive" | "planning" | "awaiting_approval";

type GlobalPermissionMode = "ask" | "accept-edits" | "auto";

type PlanApprovalAction = "approve" | "reject";

type PlanProposalStatus =
  | "pending" | "approved" | "rejected"
  | "expired" | "interrupted";

type PlanExecutionState =
  | "queued" | "running" | "completed" | "interrupted";

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
  // Which contract this approval carries; rows written before the
  // discriminator existed read back as `plan`.
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
  // Which contract was approved; selects the sidecar's execution instruction.
  kind: ProposalKind;
  plan: string;
  title: string;
  question: string;
  artifact: PlanArtifact;
  targetPermissionMode: GlobalPermissionMode;
  state: PlanExecutionState;
};

type PlansPendingResult = {
  plans: PlanProposal[];
  state?: PlanningState;
  // The contract being negotiated: the pending row's kind, else the session's
  // own contract mode. Absent when nothing is being negotiated.
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

Host notifications:

```text
method: "plans.changed"
params: {
  sessionId: string
  state: PlanningState
  kind?: ProposalKind
  proposalId?: string
  proposal?: PlanProposal
  action?: PlanApprovalAction
  targetPermissionMode?: GlobalPermissionMode | null
  execution?: PlanExecution | null
}

type ToolsOutputParams = {
  sessionId: string
  toolCallId: string
  commandShellId: CommandShellId
  stream: CommandShellOutputStream
  chunk: string
}

method: "tools.output"
params: ToolsOutputParams
```

`plans.changed` is emitted for Plan or Goal entry, submission, resolution,
execution claim/finish, and abort. Its top-level params are exactly the fields
shown; fields not applicable to a transition are omitted, and `kind` names the
contract so the renderer can pick the right mode chip and approval copy without
inspecting the projected state. For `plans.resolve`, the
host emits `targetPermissionMode` and `execution` as JSON `null` when no value
exists. Electron forwards this notification unchanged through
the shared `IPC.event.plansChanged` renderer channel.

`plans.resolve` accepts only an authenticated, still-pending request whose
proposal, session, turn, tool-call, and version match. `approve` requires an
explicit permission mode and atomically commits the `plan_approvals` row to
`status = approved`, assigns `execution_id`, sets `execution_state = queued`,
sets `sessions.mode = agent`, and stores the selected
`sessions.permission_mode`; that selection is not written into app settings
as the next approval default. Ask remains the product default. The same Agent then receives a new provider
request with Agent tools.

`reject` records `rejected` and leaves the session in its contract mode (Plan or
Goal). The absolute
30-minute deadline records `expired` with `PLAN_APPROVAL_TIMEOUT`. Abort, host
restart, sidecar restart, or persistence failure records `interrupted`. Before
serving RPC after startup, the host transactionally interrupts prior pending
approvals and queued/running execution states. Pending, queued, and running
work is never replayed; queued/running interruption after approval leaves the
session in Agent. The process epoch is internal and is not a wire or database
field.

### 5.2 Shell catalog

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

type CommandShellOutputStream = "stdout" | "stderr";
```

`commandShells.list` returns the host discovery result. Settings writes store
only a catalog ID and reject unknown, unavailable, or wrong-platform IDs with
`COMMAND_SHELL_INVALID`. If a persisted ID later becomes unavailable, the
catalog selects the first available platform shell and sets `fallback: true`.
A Bash request includes the pinned effective ID and dialect from the same turn;
host-core rejects a changed ID or dialect with `COMMAND_SHELL_CHANGED` before
permission evaluation and before spawn. Identity is not an executable path
hash.

## 6. Permission request notification

Host may emit:

```ts
method: "permissions.request"
params: {
  requestId: string
  sessionId: string
  toolCallId: string
  toolName: string
  risk: "low" | "medium" | "high"
  argsPreview: unknown
  reason: string
  timeoutMs: 120000
}
```

Electron/UI resolves via:

```ts
method: "permissions.resolve"
params: {
  requestId: string
  decision: "allow-once" | "allow-session" | "deny"
}
```

Timeout behavior (**D005**): after 120s unresolved → deny.

## 7. Error codes

| code | errorCode | meaning |
|---|---|---|
| 1000 | INTERNAL | unexpected host failure |
| 1001 | UNAUTHORIZED | missing/invalid handshake or capability |
| 1002 | INVALID_PARAMS | schema validation failed |
| 1003 | PATH_OUTSIDE_WORKSPACE | path sandbox violation before an explicit outside-path permission decision |
| 1004 | TOOL_DENIED | permission denied |
| 1005 | TOOL_TIMEOUT | tool exceeded timeout |
| 1006 | WORKSPACE_REQUIRED | no workspace bound |
| 1007 | NOT_FOUND | entity missing |
| 1008 | CONFLICT | busy/conflict state |
| 1009 | PLUGIN_INVALID | manifest/validation failure |
| 1010 | PLUGIN_LOAD_FAILED | enable/load failure |
| 1011 | PROTOCOL_MISMATCH | handshake version mismatch |
| -32029 | HOST_OVERLOADED | RPC dispatcher capacity exhausted |
| 1012 | WRITE_DISABLED_IN_PLAN | Write is unavailable in Plan and Goal |
| 1013 | EDIT_DISABLED_IN_PLAN | Edit is unavailable in Plan and Goal |
| 1014 | PLUGIN_DISABLED_IN_PLAN | plugin tools are unavailable in Plan and Goal |
| 1015 | PLAN_APPROVAL_REQUIRED | SubmitPlan/SubmitGoal is waiting for approval |
| 1016 | PLAN_APPROVAL_TIMEOUT | absolute approval deadline expired |
| 1017 | PLAN_APPROVAL_STALE | response does not match the live proposal/session/turn/tool-call/version |
| 1018 | PLAN_APPROVAL_INTERRUPTED | pending approval failed closed during abort/recovery |
| 1019 | PLAN_REQUIRES_INTERACTIVE_SESSION | unattended Plan or Goal cannot run |
| 1020 | PLAN_ARTIFACT_WRITE_FAILED | exact bytes could not be written to a new `.pi/<kind>/*.md` artifact |
| 1021 | PLAN_EXECUTION_INTERRUPTED | approved queued/running Plan or Goal execution was interrupted |
| 1022 | SHELL_NOT_FOUND | no effective platform shell is available |
| 1023 | COMMAND_SHELL_CHANGED | pinned shell ID or dialect changed before execution |

## 8. Concurrency / ordering

1. Requests may be concurrent within the dispatcher cap. Read/search tools may
   run in parallel; `Write`/`Edit` are bounded and FIFO-ordered per session,
   with at most one mutation in flight for a session.
2. Different sessions may continue concurrently across retained project tabs;
   each resolves its own project root and grants
3. Notifications may arrive anytime after handshake
4. `tools.output` preserves stdout/stderr separation and notification order;
   it is scoped to its session/tool call and has no turn or ordering fields;
   final results remain bounded
5. Abort is idempotent and shuts down the complete Bash process tree
6. Plan and Goal approval requests are proposal/session/turn/tool-call/version
   scoped;
   only one pending approval and one queued/running execution exists per
   session, and resolution is serialized by host-core
7. Startup transactionally interrupts pending approvals and queued/running
   execution states before RPC service. Late renderer responses fail closed;
   pending interruption keeps the session's contract mode and an
   already-approved queued/running interruption keeps Agent.
8. A session fork is one host-owned snapshot operation. The source transcript
   is never rewritten, and a handled child write/index failure leaves no
   visible session or orphan transcript file. A process crash follows D119's
   existing orphan-transcript recovery policy.
9. A message-scoped fork is identical except that the canonical snapshot ends
   inclusively at `throughMessageId`. It still remaps message/tool-call ids and
   creates no runtime or revision state, so later child reseed/cache state is
   isolated by the new session id.

## 9. Logging rules

- Never log API keys/secrets
- Tool args may be redacted in audit previews
- Every tools.execute gets trace id = `toolCallId`

## 10. Acceptance

1. Electron spawns host and completes handshake
2. health method returns ok
3. denied tool path returns `TOOL_DENIED`
4. timeout path returns deny decision after 120s
5. switching the selected workspace from A to B does not change the tool root
   of a call issued by session A
6. Protocol v4 `session.endTurn` creates/returns exactly one notification for
   unseen completed/failed turns and none for visible-current, aborted, or
   repeated terminal updates
7. Notification list/unread/read-all/clear round-trip through host-core and
   remain bounded to the newest 200 durable rows
8. Forking an idle session produces an independently mutable child with the
   same active transcript and durable execution configuration while leaving
   the source and its regenerate revisions unchanged
9. Forking through a message excludes every later source row and rejects an
   unknown message without creating a child
10. A forged `requestedMode` cannot authorize a tool against the durable mode;
    Plan and Goal deny Write/Edit/plugin/unknown tools and apply permission
    prompts to Bash according to `ask`/`accept-edits`/`auto`
11. SubmitPlan and SubmitGoal write exact Markdown bytes to a unique
    `.pi/plan/*.md` or `.pi/goal/*.md` file with
    hash/size and structured title/question fields; only matching
    approve/reject responses can resolve the live `plan_approvals` row, and a
    submit tool run against the other kind fails with `PLAN_KIND_MISMATCH`
    without writing an artifact
12. Plan and Goal expiry, abort, crash, scheduled rejection, and stale responses
    produce the documented durable statuses and events
13. Bash validates the pinned shell ID/dialect, streams stdout/stderr, enforces
    the 60s default/bounded override, and shuts down the complete process tree
