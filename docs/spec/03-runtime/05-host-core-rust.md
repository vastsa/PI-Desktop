# 05. Rust Host Core

## 1. Purpose

`host-core` is the privileged local backend of PI-Desktop.

It does **not** replace pi. It provides safe host capabilities to:

- Electron shell
- pi agent runtime
- plugin system

## 2. Responsibilities

1. Workspace path canonicalization, boundary checks, and permission-gated
   explicit outside paths
2. Builtin tool execution (Read/Glob/Grep/Write/Edit/Bash)
3. Authoritative durable session-mode and tool-policy evaluation
4. Permission policy evaluation, including Plan/Goal Bash prompts
5. Immutable `.pi/plan/*.md` and `.pi/goal/*.md` artifact writer,
   `plan_approvals` broker, and
   startup interruption fence
6. Selectable shell catalog, identity validation, streamed output, and process
   tree shutdown
7. Plugin registry/install/lifecycle services
8. Contribution registration bookkeeping (with TS side)
9. Persistence adapters (sessions/settings metadata, `plan_approvals` artifact
   and execution fields, and the durable notification inbox)
10. Secrets storage integration points
11. Audit logging for sensitive actions

## 3. Non-responsibilities

- LLM provider SDKs
- agent turn graph/orchestration
- React rendering
- marketplace web frontend

## 4. Suggested crate layout

```text
crates/host-core/
 src/
 main.rs # sidecar entry
 lib.rs
 rpc/
 tools/
 permissions/
 workspace/
 plugins/
 storage/
 notifications.rs
 secrets/
 audit/
 util/
```

## 5. RPC transport

Frozen: **stdio JSON-RPC NDJSON** with Electron main (see `06-host-rpc-protocol.md`).

### 5a. Control-pipe resource isolation

The host's stdin reader and stdout writer each run on one named, dedicated OS
thread. They must not use Tokio's `tokio::io::{stdin, stdout}` adapters: those
adapters obtain a blocking-pool worker for each operation, and an exhausted OS
thread budget can otherwise panic the host before a structured error reaches
Electron. The dedicated threads retry `EINTR` and transient `EAGAIN`/`EWOULDBLOCK`
(`errno` 11 or 35) with a short delay, preserve NDJSON framing, and stop only
on EOF or an unrecoverable pipe error. Failure to create either control thread
is a startup error rather than an unhandled panic.

The best-effort login-shell PATH probe follows the same rule: a failed probe
thread creation returns `None`, so Bash falls back to the host environment.

## 5b. RPC surface (logical)

Domains:

- `app.*`
- `workspace.*`
- `tools.*`
- `permissions.*`
- `plugins.*`
- `session.*` (adapter level)
- `notification.*` (adapter level; durable inbox)
- `plans.*` (approval broker and recovery)
- `shell.*` (catalog and default selection)
- `settings.*` (adapter level)
- `secrets.*`
- `audit.*`

Example:

```text
tools.execute
plans.resolve
plans.pending
permissions.request
plugins.list
plugins.load_dev
workspace.set
secrets.set
notification.list
```

## 6. Security invariants

1. No unchecked path escape from workspace tools or `.pi/plan/*.md`; an
   explicit outside path is resolved only after host permission evaluation
2. Host resolves the durable session mode; request-supplied mode is never
   authoritative
3. Plan and Goal deny Write/Edit/plugin/unknown tools before permission evaluation
4. Plan and Goal Bash follow the durable permission mode and may mutate under Auto
5. Plan and Goal artifact bytes, path, hash, size, and approval/execution identity are
   host-authenticated
6. Plan/Goal approval is host-authenticated, durable, and atomic before Agent entry
7. Effective shell ID/dialect is checked before spawn; settings reject
   unavailable/wrong-platform IDs, and a persisted unavailable choice falls
   back only during catalog selection
8. Secrets never returned to renderer logs
9. Crash in plugin, shell, or approval path fails closed and does not grant or
   replay execution

## 7. Packaging

- build target per platform
- ship binary next to Electron resources
- versioned protocol handshake with Electron/Node

## 8. MVP acceptance

1. Electron can start Rust host sidecar
2. healthcheck RPC succeeds
3. at least one tool path executes through Rust
4. permission deny path works
5. unseen completed/failed turns create exactly one durable notification
   through the `session.endTurn` transaction; results already visible in the
   focused current chat and aborted turns create none
6. a durable Plan or Goal session cannot authorize Write/Edit/plugin tools through
   a conflicting request mode, and Plan/Goal Bash follows the resolved permission
   mode
7. SubmitPlan writes exact Markdown bytes to a new `.pi/plan/*.md` artifact and
   stores durable path/hash/size plus structured title/question in
   `plan_approvals`; approval is approve/reject-only, session/turn/version
   scoped, and expires at 30 absolute minutes with
   `PLAN_APPROVAL_TIMEOUT`
8. Pending/queued/running Plan or Goal work is interrupted on host restart with no
   replay; approved interruptions leave the session Agent
9. Shell selection/fallback, stale ID/dialect rejection, stdout/stderr
   streaming, 60s timeout, bounded override, and process-tree abort are
   host-enforced
