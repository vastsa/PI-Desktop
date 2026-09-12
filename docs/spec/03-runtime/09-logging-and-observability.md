# 09. Logging and Observability

## 1. Goals

1. Diagnose failures quickly.
2. Audit sensitive tool and plugin actions.
3. Avoid leaking secrets.
4. Keep the MVP local-first and quiet during normal operation.

## 2. Log levels

- `debug`
- `info`
- `warn`
- `error`

Default runtime level:

- development: `debug`
- release: `info`

## 3. Channels

| channel | content | location |
|---|---|---|
| app | boot, IPC, window, process supervision | `~/.pi-desktop/logs/app/<category>.log` |
| host | Rust host-core events (stderr capture) | `~/.pi-desktop/logs/host/<category>.log` |
| agent | pi sidecar events (stderr capture) | `~/.pi-desktop/logs/agent/<category>.log` |
| audit | sensitive permission, tool, and plugin actions | host-core SQLite `audit_log` table |
| plugin | per-plugin logs | `~/.pi-desktop/plugins/logs/<id>.log` |

`app`, `host`, and `agent` are NDJSON files written by the Electron main
`Logger` (`apps/desktop/electron/main/logger.ts`). Host and agent stderr lines
are wrapped into records on their channel. The audit channel is stored in
SQLite, owned exclusively by host-core, so it remains queryable independently
of rotating diagnostic files.

### 3a. Category routing

The three process channels are directories, not aggregate files. Main-process
call sites choose a category. Host and agent stderr uses marker-based
classification; unknown child output uses `runtime`.

The application categories are:

- `lifecycle` — boot, shutdown, and application supervision
- `session` — prompts, turns, session lifecycle, and compaction
- `tool` — tool start/end events
- `permission` — permission requests and decisions
- `plugin` — plugin loading, services, and plugin tool execution
- `provider` — provider/model discovery, retries, and cache failures
- `persistence` — transcript and outbox persistence failures
- `updater` — updater diagnostics and errors
- `diagnostics` — blocked navigation, menu, and template diagnostics
- `runtime` — host/sidecar lifecycle and uncategorized child output

There is no dedicated `timing` category. Timing files from older application
runs are left untouched, but current code does not create or append to them.
Flat legacy `app.log`, `host.log`, and `agent.log` files are also left untouched.

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

Format: NDJSON files.

## 5. What must be logged

### Always

- app boot and shutdown;
- host/agent spawn, handshake, and unexpected exit;
- session create/delete;
- prompt accepted/aborted;
- tool start/end and permission request/decision/timeout;
- Plan artifact creation, approval, expiry, rejection, execution transition,
  and startup interruption;
- shell identity, timeout, abort, and process-tree shutdown;
- plugin enable/disable/load/error;
- tool admission rejection, queue/resource exhaustion, and updater errors.

These records should identify the relevant session, turn, tool call, plugin, or
stable error code when available. Normal successful operations should not emit
per-phase or per-request latency records.

### Never

- API keys or raw secrets;
- full secure-storage payloads; or
- unnecessary full file contents for large reads in audit records.

## 6. Redaction rules

1. Keys matching `/token|secret|password|api[_-]?key/i` are redacted.
2. Authorization headers are redacted.
3. Tool argument previews are bounded (for example, 2KB).
4. Long command output is counted or truncated in audit records; stdout/stderr
   chunks are not written wholesale to normal channels.

## 7. Trace correlation

Use one `traceId` per user-visible action when possible:

- prompt → `turnId`;
- tool call → `toolCallId`; and
- permission flow → `toolCallId` / `requestId`.

Renderer, Electron, host, and agent should propagate these identifiers.

## 7a. Functional duration metadata

The application still preserves bounded duration metadata needed by product
features: `ToolsExecuteResult.duration_ms`, transcript `toolDurationMs` and
`responseDurationMs`, delegation start/completion timestamps, and bounded
provider diagnostics. These values support the transcript, context inspector,
throughput display, and audit records; they do not create timing log lines.

Host-core audit rows may retain the existing permission and execution timing
fields for forensic inspection. They are structured audit data, not a separate
`timing.log` stream.

## 8. User-facing diagnostics

MVP provides:

1. in-app error text with a stable code;
2. an “Open logs folder” command; and
3. optional copy of error details (code and `traceId`).

There is no remote telemetry pipeline or cloud crash analytics in the MVP.

## 9. Retention

- app/host/agent category logs: rotate each category file at 5 MB and keep two
  rotated files beside it (`<category>.1.log`, `<category>.2.log`);
- audit log (SQLite): retained with the database and pruned according to the
  host retention policy; and
- rotation and logging failures must never fail the caller.

Session transcripts are user data and are not deleted by log rotation.

## 10. Acceptance

1. Failed tool calls can be traced by `toolCallId` across key logs.
2. Secrets never appear in log files during normal flows.
3. The logs folder can be opened from the app/command palette.
4. Boot, host, sidecar, plugin, updater, and renderer paths emit only their
   lifecycle, state-change, error, or security-relevant records; no timing
   category files are created for normal operation.
5. Logging or console mirroring never crashes the main process when stdout is a
   broken pipe.
6. Host restart, permission failure, shell timeout, and process abort remain
   diagnosable from stable lifecycle records and error codes.
