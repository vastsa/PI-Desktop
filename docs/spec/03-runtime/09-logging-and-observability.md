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


The `~/.pi-desktop` paths above are the packaged installation's. A development
build writes the same tree under `~/.pi-desktop-dev`, and `PI_DESKTOP_DATA_DIR`
replaces either root (D599).
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
- `tool` — tool execution outcomes and interruptions
- `permission` — permission requests and decisions
- `plugin` — plugin loading, services, and plugin tool execution
- `provider` — provider/model discovery, retries, and cache failures
- `persistence` — transcript and outbox persistence failures
- `updater` — updater diagnostics and errors
- `diagnostics` — blocked navigation, menu, template, and outbound-fetch
  diagnostics. The skill market's two channels record one
  `skillMarket.sourceFailed` / `skillMarket.documentFailed` record per source
  or document that produced nothing, with `source`, `host`, `kind`, `address`
  and — for a guard refusal — `reason`, `addressKind` and `route` in `data`. `kind`
  is `policy` when the guard judged the target's own address, `fake-ip` when it
  judged a placeholder the local proxy invented for the name (Clash's
  `198.18.0.0/15`), `unresolved` when the local resolver returned no answer, and
  `network` otherwise; `code` is `NETWORK_POLICY_BLOCKED` for the first two and
  `NETWORK_RESOLVE_FAILED` for the third, so one log line separates "the address
  is not public" from "a proxy answered with a fake-IP" from "the resolver
  answered nothing". `reason` names the guard's own branch (`url-syntax`,
  `resolve-failed`, `non-public-address`, `redirect-limit`), `addressKind` the
  class of the refused address (`benchmark` for a TUN fake-IP, `private` for
  RFC1918), and `route` the route that address was judged on (`proxied`, `direct`,
  or `unknown` when the transport reported no readable route), so a fake-IP
  refusal on a direct route reads apart from one on a route nobody could read
  (ADR 0272). The record carries the host name, the address it resolved to, that
  class and that route — never the URL, its path, query or credentials — because a
  catalog source URL is user-supplied and the refused host and address are the
  whole diagnostic value (issue #419). After a Chromium-process crash, the next
  launch writes one `crashDumpsFound` record (`error` if any new dump is the
  browser/main process, `warn` otherwise) with `count`, `total`,
  `byProcessType`, `directory`, and `newestMtimeMs`. A recovered renderer crash
  is therefore not reported as the previous app run aborting. A scan failure is
  one `crashDumpReportFailed` warn and never blocks the first window (D602).
  Each renderer `render-process-gone` event records one `renderer.process.gone`
  entry with the Electron exit `reason` and `exitCode`, plus whether the current
  main window was reloaded. Clean exits are informational; unexpected exits are
  warnings.

- `runtime` — host/sidecar lifecycle, uncategorized child output, and
  main-process `uncaughtException` / `unhandledRejection` records

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
  event: string              // stable dot-separated machine-readable name
  message: string
  traceId?: string
  requestId?: string
  sessionId?: string
  turnId?: string
  toolCallId?: string
  parentToolCallId?: string
  agentName?: string
  pluginId?: string
  executionId?: string
  code?: string
  data?: unknown
}
```

Format: NDJSON files.

`event` is the stable query key; `message` is a short human-readable summary.
Correlation fields are emitted at the top level so a failed tool, its
permission request, and its parent/child agent can be joined without parsing
free-form text. `data` is diagnostic metadata, not a transcript or command
output: it is redacted, depth/collection bounded, and capped at 8 KiB per
record.

## 5. What must be logged

### Always

- app boot and shutdown;
- host/agent spawn, handshake, and unexpected exit;
- session create/delete;
- prompt accepted/aborted;
- tool completion/failure/interruption and permission request/decision/timeout;
- Plan artifact creation, approval, expiry, rejection, execution transition,
  and startup interruption;
- shell identity, timeout, abort, and process-tree shutdown;
- plugin enable/disable/load/error;
- tool admission rejection, queue/resource exhaustion, and updater errors.

These records should identify the relevant session, turn, tool call, plugin, or
stable error code when available. A normal tool call emits one completion or
failure record after `tool_end`; an unexpected sidecar exit emits one
interruption record for each still-active tool. The sidecar protocol still
uses `tool_start` and `tool_end` unchanged for execution and transcript
correctness. Normal successful operations should not emit per-phase or
per-request latency records.

### Never

- API keys or raw secrets;
- full secure-storage payloads; or
- unnecessary full file contents for large reads in audit records.

## 6. Redaction rules

1. Keys matching token, secret, password, API key, authorization, cookie,
   credential, private key, or client secret are redacted.
2. Bearer/Basic credentials, URL user-info, and common provider token formats
   are redacted even when they occur inside a string.
3. Home, application-data, and log-directory prefixes are normalized to
   placeholders; raw local paths are not retained in diagnostic records.
4. Arbitrary strings are bounded. Structured data is bounded by depth and
   collection size and then capped at 8 KiB per record, including host-core
   audit payloads after shaping.
5. Tool arguments and results are never copied wholesale into normal logs.
   Tool results retain only safe metadata such as outcome, error code,
   duration, field names, content-block count, and stdout/stderr sizes.
   Long command output is counted or truncated in audit records.
6. Child stderr is stored as a bounded, ANSI-free `data.output` field under a
   stable `child.process.stderr` event; it is not used as the record message.

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
  host retention policy;
- Crashpad minidumps in `<data_dir>/crash-dumps` are not rotated by the
  logger; they remain until the user deletes them; and
- rotation and logging failures must never fail the caller.


Session transcripts are user data and are not deleted by log rotation.

## 10. Acceptance

1. Failed and interrupted tool calls can be traced by `toolCallId` across key
   logs, with one outcome record per normal execution.
2. Secrets never appear in log files during normal flows.
3. The logs folder can be opened from the app/command palette.
4. Boot, host, sidecar, plugin, updater, and renderer paths emit only their
   lifecycle, state-change, error, or security-relevant records; no timing
   category files are created for normal operation.
5. Logging or console mirroring never crashes the main process when stdout is a
   broken pipe.
6. Host restart, permission failure, shell timeout, and process abort remain
   diagnosable from stable lifecycle records and error codes.
