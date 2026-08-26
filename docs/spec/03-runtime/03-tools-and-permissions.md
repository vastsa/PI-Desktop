# 03. Tools and Permissions

> Decisions applied: D003, D004, D005, D006, D013, D015, D093, D114, D115, D181, D186,
> D189, D190, D195 (ADR 0057), ADR 0087

## 0. Frozen policy summary

| Topic | Decision |
|---|---|
| Default mode | Agent |
| Agent tools | Read / Glob / Grep / Write / Edit / Bash |
| Plan tools | Read / Glob / Grep / BrowserPreview / Bash / SubmitPlan |
| Goal tools | Read / Glob / Grep / BrowserPreview / Bash / SubmitGoal |
| Plan and Goal hard deny | Write / Edit / all plugin tools / unknown tools / the other kind's submit tool |
| Permission timeout | 120s → deny |
| allow-session scope | toolName |
| Bash style | non-interactive; selected host catalog shell with streamed output |
| Edit contract | line-anchored ops + whole-file `tag`; no `old_string`/`new_string` (ADR 0087) |
| asktool | interactive multi-question tool; no validity deadline; skipped answers become empty output fields |

## 1. Goal

Let the agent get things done, but stay under control by default.

## 2. MVP Built-in Tools

| Tool | Risk | Description |
|---|---|---|
| `Read` | low | Read files within the workspace; returns line-numbered content and a `[path#TAG]` header |
| `new_context` | low | Start a new context window at the next turn boundary; takes no parameters and changes no environment state |
| `Glob` | low | List files by pattern |
| `Grep` | low | Content search; mints a per-file `tag` |
| `BrowserPreview` | low | Open a workspace-relative preview in the user-driven Browser panel |
| `EnterPlanMode` | low | Move the same Agent from Agent to Plan after host validation |
| `SubmitPlan` | low | Preserve exact Markdown bytes in a new `.pi/plan/*.md` artifact and request approval |
| `EnterGoalMode` | low | Move the same Agent from Agent to Goal after host validation |
| `SubmitGoal` | low | Preserve exact Markdown bytes in a new `.pi/goal/*.md` artifact and request approval |
| `Write` | high | Create/overwrite files; returns the post-write `tag` |
| `Edit` | high | Modify files through line-anchored ops against a verified `tag` ([18](18-line-anchored-edit-contract.md)) |
| `Bash` | high | Execute commands |
| `asktool` | low | Ask one or more user questions and return the submitted answers as tool output |

> Names may be fine-tuned during implementation, but semantics stay consistent.

### 2.1 Deferred ancillary tools (D185, ADR 0048)

Following pi's coding-agent default, the first Agent request activates only
`Read`, `Bash`, `Edit`, and `Write`; `Glob` and `Grep` are loaded on demand.
Plan and Goal keep their read/inspection core. The runtime also registers capabilities
without sending their full schemas up front:

- `Glob` and `Grep` in Agent mode
- `BrowserPreview`
- `PluginCheck`, `PluginScaffold`, and `PluginPack`
- plugin-declared agent tools
- `Skill` when an enabled plugin contributes skills

These tools appear in a bounded `# On-demand tools` catalog with compact
descriptions. The model calls the local `ToolSearch` tool with an exact name or
capability query; the matching schemas become available on the next model turn.
The sidecar resets this deferred set at the beginning of every new user prompt.
The host permission, workspace/scratch containment, timeout, and audit rules do
not change when a tool is loaded. `ToolSearch` itself never executes a workspace
operation and never bypasses host-core policy.

## 3. Common Tool Constraints

Every non-interactive execution tool must have:

1. JSON schema / typebox parameter definition
2. timeout
3. workspace path validation
4. output truncation policy
5. trace id
6. structured results

`asktool` is the interactive exception: it has a typed request event, waits for
the renderer response without an expiry, and returns a bounded structured tool
result. Stopping the turn resolves outstanding questions as skipped.

## 4. Path Rules

Native file and search tools enforce distinct path shapes (D208, ADR 0069):

- `Read.path` is an existing regular file. A directory returns
  `INVALID_ARGUMENT` with a structured `Glob` suggestion rather than a generic
  execution failure.
- `Glob.path` is a directory search root.
- `Grep.path` may be one file or a directory tree. A directly named file is
  searched without walking siblings, while `include` still filters its base
  name and every output budget remains unchanged.

Agent mode keeps `Glob`/`Grep` deferred under D185. Each new user prompt resets
their activation, so directory discovery activates `Glob` through `ToolSearch`
for that prompt instead of guessing a file name or calling `Read` on a
directory.

- For a durable `sessionId`, `workspaceRoot` is resolved from that session's
  persisted project binding. A path-less temporary session instead binds its
  `workspaceRoot` to `<data_dir>/scratch/<sessionId>`. Neither root is read
  from the mutable active sidebar tab at execution time.
- All file paths are relative to the resolved `workspaceRoot` by default
- After normalization they must still reside within the workspace unless the
  call receives explicit outside-path permission
- `..` escapes and symlink escapes are outside-path requests, not implicit
  access
- Symlinks are resolved again immediately before execution, after permission
  approval, so approval cannot skip the canonicalization step
- Exception (D114): absolute paths inside the session scratch directory are a
  second legal root for `Read`/`Write`/`Edit` — see §4b. Both roots run the
  same lexical + symlink containment defense. `Read`/`Glob`/`Grep`/`Write`/`Edit`
  may address an explicit path outside both roots only through the permission
  policy below; a denied or unapproved request returns `TOOL_DENIED`.

### 4a. Explicit outside-path permission

An explicit `path` argument that resolves outside the session workspace and
scratch roots is a separate capability. The host checks it before the normal
low-risk auto-allow decision:

- `auto` allows the outside path without a card;
- `ask` and `accept-edits` emit the ordinary permission card;
- `allow-once` executes only the current call, while `allow-session` follows
  the existing per-tool session grant scope;
- denial, timeout, or cancellation never executes the operation;
- relative `..` escapes and symlink escapes use the same rule as absolute
  paths;
- successful external `Read`/`Write`/`Edit` results carry `root: "external"`
  and an absolute canonical path; external `Glob`/`Grep` matches are absolute
  so the access remains visible in the transcript.

The exception applies only to the explicit path argument. It does not expand
the workspace root, Bash's working directory, or any implicit directory walk.

## 4b. Session scratch directory (D114)

Temporary/intermediate files an agent produces (one-off scripts, downloaded
data, drafts) must not dirty the user's project or its git status. Each
session gets a scratch directory outside the workspace:

```text
<data_dir>/scratch/<sessionId>/
```

OS clipboard files and images pasted into the composer are materialized by
Electron main below `<data_dir>/scratch/<sessionId>/pasted/` before their
paths and metadata are captured as transient composer references. At dispatch,
main validates the source against the session scratch/project roots. Images are
also copied into the content-addressed `<data_dir>/attachments/<sha256>` store;
known pi-ai models with `input: ["text", "image"]` receive eligible image
blocks, while non-vision/unknown models and oversized images receive `@`
fallback paths. They use the same session lifecycle as other scratch data and
do not enter the workspace, artifacts, or the persisted prompt as binary
content.

- **Addressing.** In a project session, the model addresses scratch by absolute
  path only; the path is advertised in the system prompt, relative tool paths
  resolve against the project workspace, and `Bash` exports
  `PI_SCRATCH_DIR`. In a temporary session, that same scratch directory is the
  session workspace root, so relative Read/Glob/Grep/Write/Edit/Bash paths work
  there without inheriting a project.
- **Containment.** `resolve_tool_path` tries the workspace root first, then
  the scratch root, applying the identical two-layer defense (lexical `..`
  normalization + canonicalized-ancestor symlink check) to each. A symlink
  planted inside scratch cannot reach the workspace or anywhere else.
- **Permissions.** `Write`/`Edit` whose `path` is lexically inside the
  session's scratch root auto-allow without a permission card — they cannot
  touch the project. The lexical check only skips the prompt; execution still
  goes through the full resolver, so it is not an escape vector. Plan and Goal do
  not expose Write/Edit, so the scratch auto-allow rule cannot make those tools
  available in either. A contract-mode Bash call may still create or mutate
  scratch data when its permission mode allows it.
- **Artifacts.** Successful scratch writes are not recorded in the
  `artifacts` table; artifact-driven file tabs represent workspace
  deliverables only, while the Files surface may still browse the active
  workspace. Tool results carry `root: "workspace" | "scratch"` to make this
  decision and the UI rendering explicit.
- **Tool coverage.** `Read`/`Write`/`Edit` use the workspace and scratch roots;
  `Glob`/`Grep` use the workspace root by default and may search an explicitly
  scoped scratch directory or an explicitly approved external directory. The
  model should use bounded native search tools instead of shell directory
  walks.
  `BrowserPreview` remains workspace-relative in v1. Its Main-process handler
  resolves the root from the originating durable session, and the renderer
  event carries `sessionId`; the selected foreground workspace is never used
  for a background preview.
- **Lifecycle.** Created lazily on the first `Write`/`Edit`/`Bash` or
  composer clipboard paste of a session. Deleted with `session.delete`. A
  startup sweep removes scratch dirs whose session no longer exists and dirs
  untouched for over 7 days (crash/force-quit fallback; no scheduled job
  needed).
- A project switch does not redirect or cancel a background session's tools;
  sessions A and B remain sandboxed to projects A and B respectively.
- A Temporary/path-less session uses only its own scratch directory as its
  workspace root, even if another project is visible or recently active. It
  never inherits that project. Plan and Goal still require a persisted project
  root, so this binding does not expand contract-mode execution. High-risk
  tools operate only inside the temporary session's scratch root.
- Legacy calls that do not resolve to a durable session may use the selected
  host workspace only during the compatibility window.
- A session lookup/storage error fails the tool request; it must never be
  treated as a missing legacy session or redirected to the selected workspace.

## 4c. Message-owned review snapshots and rollback

`Write` and `Edit` are the structured review boundary. For a successful
workspace-root mutation, host-core captures the previous file before execution
and adds bounded review evidence to the tool result:

```ts
type ReviewChange = {
  version: 1;
  snapshotId: string;
  messageId: string;
  path: string;
  operation: "write" | "edit" | "delete";
  status: "added" | "modified" | "deleted";
  state: "active" | "rolledBack";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  binary?: boolean;
  truncated?: boolean;
  reversible: boolean;
};
```

- The renderer persists and displays this record with the tool message; it
  does not recompute Review from Git, `HEAD`, or the current dirty tree.
- Scratch-root, failed, denied, and unresolvable writes have no `review`
  record. Binary or oversized content may omit hunks and be non-reversible.
- Rollback is host-owned and hash-guarded. It restores the captured previous
  bytes, or removes a newly-created file, only when the current content still
  equals the post-tool hash. A later edit returns `conflict` without touching
  the file. A completed rollback invalidates the session's snapshot entries for
  that path, so the model cannot keep editing against a tag the rollback
  replaced.
- An `Edit` carrying `MV DEST` records two entries under one tool call — a
  source deletion and a destination creation — and rollback restores both or
  neither. `REM` records a deletion whose rollback restores the captured bytes.
  The hash guard uses the full digest, not the 16-bit `tag`.
- Review snapshot files live outside the workspace and are removed with their
  session; orphaned session directories are swept on host startup.

## 4d. Mutation ordering and edit recovery

`Write` and `Edit` are serialized within each session. Read/search tools may
continue in parallel, and different sessions may mutate different roots
concurrently, but a session never has two in-flight mutations. The host holds
the per-session mutation permit before consuming a global mutation slot, so a
queued mutation cannot reserve capacity while it waits for an earlier edit.

`Edit` names positions and supplies new content only; it never matches existing
text. Every call carries the whole-file `tag` minted by whichever tool last
displayed the content, and the host rejects a call whose tag does not hash the
live file or whose anchors reference lines this session never displayed. The full
contract — tag computation, the session snapshot store, the op grammar, block
resolution, registers, and drift recovery — is
[18-line-anchored-edit-contract](18-line-anchored-edit-contract.md); this section
keeps only the ordering and loop-guard rules. The agent mutation workflow is:

1. Edit the deliverable directly with `Edit` or `Write` when it is inside the
   advertised workspace.
2. If a dedicated worktree is outside that root, perform one guarded edit in
   that worktree with Bash and verify the resulting diff.
3. After a failed edit or patch check, perform one fresh `Read` of the current
   target and regenerate the change once. Once a path has spent its recovery
   budget (18-line-anchored-edit-contract §9.3), the next failed `Edit` for that
   path in the prompt — or a second failed shell patch command (`apply_patch`,
   `git apply`, or `patch`) — returns a terminating tool result, so the agent
   stops after reporting the exact mismatch. Do not hand-edit old unified-diff
   hunk headers or continue a repair loop.
4. Keep mutations to one path sequential, even when read/search calls are
   issued in parallel.

An `EDIT_LINES_UNSEEN` rejection whose reveal was complete is exempt from step
3's re-read: the error already displayed the missing lines and merged them into
the session's provenance, so the same `tag` retried unchanged applies. That
retry is also the one grace `EDIT_LINES_UNSEEN` gets on the path, so a second
one does count toward the guard.

Serialization also protects the snapshot store, which both producers and `Edit`
mutate: without the per-session permit, a concurrent record could land between a
validation and its write.

The sidecar's tool timing line includes `mutationFailureKind` and
`mutationFailureAttempt` for failed same-path `Edit` calls and recognized shell
patch commands, `mutationFailureGrace=true` for a failure forgiven under §9.3,
and `terminate=true` on the failure that exhausts the budget. The last is passed
through pi-agent-core's runtime-only termination hint; it does not alter the
durable tool result shape. Because that hint ends the agent loop, the runtime
also finalizes the assistant row with `MUTATION_RETRY_BUDGET_EXHAUSTED` instead
of letting the turn complete silently.

## 5. Bash Rules

Host execution baseline:

- A project-bound session workspace is required
- Default cwd = the originating session's `workspaceRoot`
- Confirmation required by default
- Set a mandatory 60s timeout; accept only a bounded 1s–300s override
- Stream stdout and stderr separately, then return bounded final output
- Truncate large output without mixing the two streams
- No interactive TTY (MVP)
- A command that exits non-zero returns `ok: false`, `isError: true`, and
  `errorCode: TOOL_FAILED` while preserving its `exitCode`, stdout, and stderr
  in `content` so the agent can diagnose the command without blindly retrying.

Shell catalog (D190) exposes the stable IDs `windows-powershell`, `cmd`,
`git-bash`, and `bash` where supported by the platform. The host persists
`defaultCommandShell`; if that persisted choice later becomes unavailable, the
effective catalog selection intentionally falls back to the first available
platform shell. A turn pins the effective shell ID and dialect. `Bash` remains
the tool/protocol name, and the request carries the pinned shell ID separately.
Host-core resolves the entry again before spawn and rejects a changed ID/dialect
with `COMMAND_SHELL_CHANGED`; settings writes reject unavailable or
wrong-platform IDs with `COMMAND_SHELL_INVALID`. No arbitrary executable path
or executable path hash is accepted as shell identity.

1. `PI_DESKTOP_BASH` env override (path to a bash executable)
2. Unix: well-known locations (`/bin/bash`, `/usr/bin/bash`, `/usr/local/bin/bash`, Homebrew), then PATH
3. Windows: `bash.exe` from Git for Windows — derived from the `git` on PATH, then standard install dirs, then PATH excluding the WSL launcher in `System32`

- Unix invokes `bash -lc` (login shell keeps profile PATH for Finder/Dock launches); Windows invokes `bash -c` with `CREATE_NO_WINDOW`
- On Unix, the Bash tool additionally probes the user's login shell for its
  PATH — `$SHELL` (fallback `/bin/zsh` → `/bin/bash` → `/bin/sh`) with
  `-lic 'printf %s "$PATH"'`, 5s-bounded, cached per process — and injects it
  into every subprocess. `bash -lc` alone sources only the *bash* profile; on
  macOS the default shell is zsh, so nvm/pnpm/Homebrew initialized in
  `~/.zshrc` / `~/.zprofile` would otherwise be invisible to agent commands.
  The probe is best-effort: missing shell, non-zero exit, or timeout fall back
  to the host PATH unchanged. Agent commands stay POSIX bash (D181 / ADR 0045).
- No bash bundled in the installer: Git for Windows is the Windows prerequisite (the app requires git anyway)
- Resolution failure returns stable `SHELL_NOT_FOUND` with install guidance
- Windows PowerShell and cmd use their native non-interactive invocation.
- Git Bash uses the discovered Git for Windows executable.
- Unix Bash uses an approved system Bash entry.
- User abort and timeout terminate the complete process tree before returning.

Initial denylist (extensible):

- Directly reading/writing sensitive paths outside the workspace
- Destructive operations without confirmation (policy governed by the permission layer)

## 6. Permission Model

### Risk Levels

| risk | Example | Default policy |
|---|---|---|
| low | Read/Glob/Grep inside the session roots | Auto-allow |
| medium | low-risk network/metadata | Confirm or allow by policy |
| high | Write/Edit/Bash | Confirm by default |

### Decision Types

- `allow-once`
- `allow-session`
- `deny`

May be added later:
- `allow-always-for-tool`
- `allow-always-for-command-pattern`

### Permission Modes (D115/D132)

How high-risk tool calls get approved is governed by a **permission mode**:

| Mode | Write/Edit | Bash / plugin tools |
|---|---|---|
| `ask` (default) | confirm | confirm |
| `accept-edits` | auto-allow | confirm |
| `auto` | auto-allow | auto-allow |

An explicit outside-workspace path is an exception to the low-risk row: it is
auto-allowed only in `auto`; `ask` and `accept-edits` both confirm it.

Resolution order per tool call (host-core `tools.execute`):

1. Session's persisted `permission_mode`, unless it is `inherit`
2. Global `defaultPermissionMode` from app settings (`ask` / `accept-edits` / `auto`)
3. `ask`

Rules:

- The session value is stored in `sessions.permission_mode`
  (`inherit | ask | accept-edits | auto`, default `inherit`, schema v5) and
  set via `session.configure` `permissionMode`.
- Plan's hard deny wins over every permission mode for Write/Edit and plugin
  tools. `auto` cannot re-enable a hidden or denied tool.
- Low-risk tools (`Read`/`Glob`/`Grep`) inside the session roots auto-allow in
  every mode, as before.
- `BrowserPreview` is an explicit read-only UI inspection capability and is
  available in both operating modes.
- Plan retains the permission-mode selector. Bash is confirmed under `ask` and
  `accept-edits`, and is auto-allowed under `auto`; therefore Plan is planning
  intent, not a strict read-only security profile.
- `allow-session` grants continue to work under `ask` and stay scoped to the
  session; under `accept-edits`/`auto` they are simply never needed.
- Scratch-directory writes (D114) stay prompt-free in every mode.
- UI: Settings → segmented global default; composer shows a per-session chip in
  Agent, Plan, and Goal whose menu offers the three effective modes without a
  separate global-default/inherit entry. The chip and selected menu item
  display the effective mode; choosing an item stores that explicit session
  override. Existing inherited sessions continue to resolve through the
  global setting until the user chooses a mode.
- Enforcement lives in host-core only; the sidecar/model is never told the
  mode and cannot influence it.

## 7. Permission Flow

```text
tool call
 → policy.evaluate()
 → allow? execute
 → need confirm? push to UI
 → deny? return tool error result
```

Permission confirmation timeout:
- After 120s, auto-deny (D005: fail closed, do not hang forever)

## 8. Tool Result Visibility to the Model

- Success result: given to the model
- Failure result: given to the model (with error info)
- User denial: give the model an explicit "user denied permission"
- Sensitive info: redact before persisting/displaying

## 9. Auditing

Each tool call records:

- sessionId
- turnId
- toolCallId
- toolName
- args hash / preview
- externalPathPermission classification when an explicit path is present
- decision
- duration
- success / error code

MVP may start by writing to SQLite or a log file.

Timing is recorded in segments, not as one duration (D183): `prompted`
(whether a permission card was shown), `permissionWaitMs`, `durationMs` (the
tool body), `overheadMs` (host bookkeeping), and `totalMs`. Denied calls carry
the same fields with a zero tool body. See
[09. Logging and Observability](09-logging-and-observability.md) for the
matching log lines.

## 10. Operating-mode matrix

| Mode | Read/Glob/Grep | BrowserPreview | Write/Edit | Bash | Plugins |
|---|---|---|---|---|---|
| Agent | allow | allow | permission policy | permission policy | registered risk policy |
| Plan | allow | allow | deny | `ask`/`accept-edits`: confirm; `auto`: allow | deny |
| Goal | allow | allow | deny | `ask`/`accept-edits`: confirm; `auto`: allow | deny |

### Notes
- Plan and Goal hard-deny Write/Edit/plugin tools before permission UI; a direct host
  call cannot bypass the matrix.
- Agent mode uses permission cards or the selected automatic policy for
  Write/Edit/Bash and registered plugin tools.
- Plan and Goal Bash may mutate workspace or scratch state when the user selected Auto;
  the UI must make that tradeoff visible.
- allow-session is remembered per toolName for the active session only
- Session grants follow `sessionId` across project-tab switches and are never
  inherited by another session or Temporary conversation

### 10.1 Plan and Goal control tools

`new_context` is available in every mode and needs no confirmation: it only asks
the runtime to compact at the next turn boundary, which the host would do on its
own once the hard budget is reached (see
[02-agent-runtime](02-agent-runtime.md) §5.1). A submit
tool is available only in its own contract mode and must be the only tool call in its assistant batch. It preserves
the exact Markdown bytes in a new unique artifact under the kind's directory
(`.pi/plan/*.md` for `SubmitPlan`, `.pi/goal/*.md` for `SubmitGoal`)
through host-core before creating one pending approval. `EnterPlanMode` and
`EnterGoalMode` are available only in Agent, and each must be the only tool call
in its batch. The host validates the durable mode, the proposal kind, and the
active-turn/configuration boundary before any transition; the visible tool list
is guidance, not the security boundary.

### 10.2 Delegation and subagent tool scope (D201, ADR 0062)

`Task` is available in Agent mode only, and only when the session has at least
one subagent definition. Plan and Goal are read-only contract negotiations, so a
delegate with `Bash`, `Edit` or `Write` would drive straight through them.

A definition declares the tools its delegate may call, drawn only from `Read`,
`Glob`, `Grep`, `BrowserPreview`, `Bash`, `Edit` and `Write`. A definition that
declares none gets `Read`, `Glob`, `Grep`; `tools: "*"` means all seven, which is
still only those seven. An unrecognized name is dropped with a parse warning.
Plugin tools, `Skill`, `ToolSearch`, `new_context`, the mode tools and `Task`
itself are never assignable: a delegate is a bounded file/search/shell worker,
not a second session.

A delegate's available tools are its definition's, never its session's. It
cannot gain a tool because the parent has it, and a session cannot lend
mutation rights to a read-only delegate. Delegate calls are built by the
session runtime and go through the same `tools.execute` path, so path rules
(§4), Bash rules (§5), permission modes (§6), the operating-mode matrix (§10)
and auditing (§9) apply unchanged — evaluated against the owning session.

A **builtin or user** definition may additionally declare `permission: inherit
| ask | accept-edits | auto` (ADR 0089, default `inherit`). With the default
`inherit` (including all builtins), the sidecar attaches no override and the
delegate uses the session's effective permission mode. Thus a parent in `auto`
allows the delegate's explicit external paths without a second authorization
card. A project definition may not declare a scope: it arrives with the
repository, so its declaration is dropped at parse time with a warning and its
delegates resolve under the session's effective mode — cloning a repository
never grants it a permission upgrade. When an eligible builtin or user
explicitly declares a non-`inherit` scope, the sidecar attaches it to the
delegate's `tools.execute` calls and host-core resolves each call under that
mode instead of the session's effective permission mode. The scope is a
permission-mode override only: the contract modes' hard deny and the
external-path gate (§4.1) stay in force. `accept-edits` therefore auto-allows
`Write`/`Edit` inside the workspace and scratch roots, while external paths and
other tools retain their normal approval behavior.

Permission requests from a delegate carry the asking delegate's name, so the
card can say which delegate wants the call (see `04-ux/03-permission-ux.md`
§6a).
Session-scoped `allow-session` grants are still per `toolName` and per session:
one delegate's approval of `Bash` applies to the whole session, including the
parent and other delegates.

## 11. Plugin Tools

Plugins can contribute tools via `agentTools` in Agent only:

1. manifest declaration
2. user grants `agent.tool.register`
3. PluginManager registers them into the ToolHost
4. execution goes through the unified permission/audit/timeout wrapper

No plugin tool is visible or executable in Plan or Goal, regardless of manifest
risk, declared permission, session grant, or `auto`. A direct attempt returns
`PLUGIN_DISABLED_IN_PLAN` — the `_IN_PLAN` codes are shared by both contract
modes rather than duplicated per kind — and is audited as a contract-mode policy
denial. Missing or invalid plugin risk defaults to `medium` for Agent and never
grants contract-mode access.

Naming:
- Internal full name: `plugin.<pluginId>.<toolName>`
- Name exposed to the model: forced prefix `plugin_<pluginIdSafe>_<toolName>` (D015) to avoid conflicts

## 12. Future Extensions

- MCP tools
- tool group toggles
- command allowlist / denylist
- dry-run mode
- apply patches after preview
