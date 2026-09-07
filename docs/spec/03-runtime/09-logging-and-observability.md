# 09. Logging and Observability

## 1. Goals

1. Diagnose failures quickly
2. Audit sensitive tool/plugin actions
3. Avoid leaking secrets
4. Keep MVP simple (local files first)

## 2. Log levels

- `debug`
- `info`
- `warn`
- `error`

Default runtime level:

- dev: `debug`
- release: `info`

## 3. Channels

| channel | content | location |
|---|---|---|
| app | boot, ipc, window, process supervision | `~/.pi-desktop/logs/app/<category>.log` |
| host | rust host-core events (stderr capture) | `~/.pi-desktop/logs/host/<category>.log` |
| agent | pi sidecar turn/provider events (stderr capture) | `~/.pi-desktop/logs/agent/<category>.log` |
| audit | permissions/tools/plugins sensitive actions | host-core SQLite `audit_log` table |
| plugin | per-plugin logs | `~/.pi-desktop/plugins/logs/<id>.log` |

Notes:

- `app`/`host`/`agent` are NDJSON files written by the Electron main
  `Logger` (`apps/desktop/electron/main/logger.ts`); host/agent stderr lines
  are wrapped into records on their channel.
- The audit channel is stored in SQLite (owned by host-core, D006) instead of
  a flat file: it needs queryability and longer retention than debug logs.
  `logs folder` diagnostics still apply to the three file channels.

### 3a. Category routing

The three process channels are directories, not aggregate files. The main
process writes each record to `<channel>/<category>.log`, so high-volume
session, tool, timing, and provider records can be inspected independently.

The app channel uses these categories:

- `lifecycle` — boot, shutdown, and application supervision
- `session` — prompts, turns, session lifecycle, and compaction
- `tool` — tool start/end events
- `permission` — permission requests and decisions
- `plugin` — plugin loading, services, and plugin tool execution
- `provider` — provider/model discovery and cache failures
- `persistence` — transcript and outbox persistence failures
- `updater` — electron-updater diagnostics
- `diagnostics` — blocked navigation, menu, and template diagnostics
- `runtime` — host/sidecar lifecycle events

Host and agent stderr is classified into the same categories when the line
contains a recognizable subsystem marker. Timing lines are always routed to
`host/timing.log` or `agent/timing.log`; unknown child output goes to that
channel's `runtime.log`. Every record includes its `category` field.

The flat `app.log`, `host.log`, and `agent.log` names are no longer written.
Existing legacy files are left untouched during the layout transition.

## 4. Required fields

Every structured log line should include:

```ts
type LogRecord = {
  ts: string
  level: "debug" | "info" | "warn" | "error"
  channel: string
  category: string
  message: string
  traceId?: string
  sessionId?: string
  turnId?: string
  toolCallId?: string
  pluginId?: string
  code?: string
  data?: unknown
}
```

Format MVP: NDJSON files.

## 5. What must be logged

### Always
- app boot/shutdown
- host/agent spawn + handshake result
- session create/delete
- prompt accepted/aborted
- tool start/end
- permission request/decision/timeout
- Plan artifact creation (unique path, SHA-256, byte size), approval/expiry/
  reject, execution transition, and startup interruption
- shell ID/effective dialect, availability/fallback or changed-selection failure, stream
  byte counts, timeout, and process-tree shutdown
- plugin enable/disable/load/error
- tool admission rejection, queue depth, active class budgets, and shell spawn
  resource exhaustion

### Never
- API keys / raw secrets
- full secure storage payloads
- unnecessary full file contents for huge reads in audit (use hashes/previews)

## 6. Redaction rules

1. Keys matching `/token|secret|password|api[_-]?key/i` redacted
2. Authorization headers redacted
3. Tool args preview truncated (e.g. 2KB)
4. Long command output is counted/truncated in audit; stdout/stderr chunks are
   never logged wholesale in normal channels

## 7. Trace correlation

Use one `traceId` per user-visible action when possible:

- prompt → turnId
- tool call → toolCallId
- permission flow shares toolCallId/requestId

Renderer, Electron, host, agent should propagate these IDs.

## 7a. Latency segmentation (D183)

A slow agent turn is almost never slow inside the tool. The wait belongs to
one of three stages, and each stage is logged separately so they can be told
apart without guessing:

| stage | where | field |
|---|---|---|
| approval | host-core `tools.execute` | `permission_wait_ms` |
| tool body | host-core tool implementation | `execute_ms` (`durationMs` in audit) |
| host bookkeeping | host-core (workspace resolve, lock, artifacts, audit) | `overhead_ms` |
| instruction preflight | sidecar, path-scoped chain before `tools.execute` | `instructionResolveMs` |
| host round trip incl. IPC | sidecar around `tools.execute` | `hostRttMs` |
| provider first token | sidecar, request → `message_start` | `providerWaitMs` |
| provider streaming | sidecar, `message_start` → `message_end` | `streamMs` |

- host-core emits one `tool timing` line per call on the `host` channel with
  `prompted`, `permission_wait_ms`, `execute_ms`, `overhead_ms`, `total_ms`,
  and `outcome` (`ok` / `error` / `denied`); the same fields are persisted on
  the `tool_execute` / `tool_denied` audit rows.
- the sidecar writes greppable `[timing] kind=<tool|model|subagent> key=value`
  lines to stderr, which the Electron `Logger` wraps into the `agent` channel.
  Set `PI_DESKTOP_TIMING=0` (or `off`/`false`) to suppress them.
- `hostRttMs` minus the host's `total_ms` for the same `toolCallId` is the
  stdio/IPC cost; `providerWaitMs` covers pi-ai's own retry backoff, so a
  provider that burns its retries shows up there rather than as a slow tool.
- `instructionResolveMs` measures the path-scoped instruction preflight and
  does not belong to the command body. `instructionCacheHit=true` identifies a
  same-prompt directory claim; `instructionFallback=base` identifies a
  timeout or resolver failure that continued with the runtime's base chain.
- failed or aborted turns still emit a `kind=model` line with the outcome, so
  a turn that never produced tokens is still measurable.
- one `kind=subagent` line closes every `Task` call (D201, ADR 0062) with
  `agent`, `toolCallId`, `sessionId`, `turnId`, `provider`, `model`, `status`,
  `turns`, `toolCalls`, `durationMs`, and `errorCode` on failure. Delegate rows
  are attributed in the transcript but their tool and model lines are not, so
  this is what tells a parallel fan-out apart: same `turnId`, one line per
  delegate, each with its own provider and wall-clock cost. Idle and duration
  watchdogs are withdrawn (D328); a stored `timed_out` line may still carry
  `SUBAGENT_IDLE_TIMEOUT` or `SUBAGENT_DURATION_TIMEOUT`.

The assistant transcript also preserves the successful stream duration as
`UiMessage.responseDurationMs`. The renderer combines it with provider-reported
output tokens to show generation speed in `tokens/s`; this is a presentation
projection of the same `streamMs` interval, not a second timing source. Tool
rows carry a separate estimated argument/result footprint for context
inspection, while exact provider input/output usage remains authoritative.

Plan and shell records use the same `sessionId`, `turnId`, and `toolCallId`
correlation fields. Artifact logs include only the unique relative path under
`.pi/plan/`, hash, and size; shell logs include the catalog ID and dialect,
never an arbitrary executable command line or path hash from the renderer.

## 8. User-facing diagnostics

MVP provides:

1. in-app error text with code
2. “Open logs folder” command
3. optional copy error details (code + traceId)

Not in MVP:

- remote telemetry pipeline
- cloud crash analytics (can be added later behind consent)

## 9. Retention

- app/host/agent category logs: size-capped rotation — rotate each category
  file at 5 MB, keep 2 rotated files beside it (`<category>.1.log`,
  `<category>.2.log`)
- audit log (SQLite): retained with the database; longer than debug logs
- rotation must never fail the caller; disk trouble is swallowed

## 10. Acceptance

1. Failed tool call can be traced by toolCallId across logs
2. secrets never appear in log files during normal flows
3. logs folder openable from app/command palette
4. a slow tool call can be attributed to approval, execution, or the provider
   from the logs alone (D183)
5. a host resource incident exposes active/queued tool budgets and a single
   restart generation instead of repeated stale-pipe errors
6. Plan startup interruption and shell changed-selection/timeout/process abort
   can be diagnosed from session/turn/tool-call correlation and stable error
   code
