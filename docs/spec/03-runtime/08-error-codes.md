# 08. Error Codes

> Source of truth: `packages/shared/src/errors.ts` (`ErrorCodes`). Codes in
> §3.7 are reserved (documented ahead of emission); everything else is live.

## 1. Goal

Provide one stable error vocabulary across:

- Renderer UI
- Electron IPC
- Rust host RPC
- Node pi sidecar bridge

## 2. Error object

```ts
type AppError = {
  code: string            // stable machine code, e.g. TOOL_DENIED
  message: string         // English UI/default message
  details?: unknown
  retriable?: boolean
  source?: "renderer" | "electron" | "host" | "agent" | "plugin"
  causeCode?: string      // nested/transport code if mapped
  traceId?: string
}
```

Rules:

1. `code` is immutable once published
2. `message` is English source text (i18n key may map separately)
3. UI should prefer i18n key derived from `code` when available

## 3. Code registry

### 3.1 App / protocol

| code | retriable | meaning |
|---|---|---|
| `PROTOCOL_MISMATCH` | no | handshake/protocol version mismatch |
| `HOST_UNAVAILABLE` | yes | Rust host not running/reachable |
| `HOST_OVERLOADED` | yes | bounded host RPC/tool capacity is full; retry after backpressure |
| `AGENT_UNAVAILABLE` | yes | pi sidecar not running/reachable |
| `APP_DEGRADED` | yes | app running with limited capabilities |
| `INTERNAL` | maybe | unexpected internal failure |
| `INVALID_ARGUMENT` | no | request schema/args invalid, including a native-tool path of the wrong file/directory kind |
| `UNAUTHORIZED` | no | capability/auth boundary rejected call |
| `NOT_FOUND` | no | entity not found |
| `CONFLICT` | maybe | state conflict / busy resource |
| `TIMEOUT` | yes | generic timeout |

`HOST_UNAVAILABLE` is reserved for a missing or broken host process/transport,
not ordinary admission pressure. RPC capacity returns `HOST_OVERLOADED`, and
an admitted shell that cannot start because the OS is temporarily out of
process resources returns `PROCESS_RESOURCE_EXHAUSTED`. Host-core's control
stdio is isolated from Tokio's dynamic blocking pool so the latter condition
does not turn temporary thread pressure into a host process exit.

### 3.2 Agent / session

| code | retriable | meaning |
|---|---|---|
| `AGENT_BUSY` | no | session already has active turn |
| `AGENT_NOT_FOUND` | no | session missing |
| `TURN_NOT_FOUND` | no | turn id invalid |
| `TURN_ABORTED` | no | turn aborted by user/system |
| `MODEL_NOT_CONFIGURED` | no | no usable model selected, or provider rejects the selected model as unknown |
| `PROVIDER_ERROR` | yes | upstream provider failure; a retryable one (5xx gateway) gets up to four same-turn retries, a malformed 400/422 request is terminal |
| `PROVIDER_UNAUTHORIZED` | no | bad/missing provider credentials |
| `PROVIDER_RATE_LIMITED` | yes | provider rate limited; runtime silently retries up to five times across setup/stream before the terminal event |
| `CONTEXT_TOO_LARGE` | no | prompt/context still exceeds the safe model budget after recovery, the second provider overflow occurred, or automatic recovery is disabled |
| `CONTEXT_COMPACTION_FAILED` | no | automatic retained-tail recovery could not prepare, persist, or fit a checkpoint, or manual checkpoint summary generation / durable append failed; the guarded next provider request does not start |
| `STREAM_FAILED` | yes | provider stream was terminated, closed prematurely, or otherwise ended before a complete response; up to four same-turn retries may precede the terminal event |
| `EMPTY_MODEL_RESPONSE` | yes | the model ended its turn with no tool call and no visible text twice: once as streamed, once after the automatic re-run (spec 02-agent-runtime §5e) |
| `PROMPT_ENHANCEMENT_EMPTY` | no | the one-shot enhancement model returned no text |
| `SUBAGENT_IDLE_TIMEOUT` | no | a delegate emitted no agent event at all for its configured idle window, with the timer paused across tool execution |
| `SUBAGENT_DURATION_TIMEOUT` | no | a delegate exceeded its configured total runtime, including tool execution |

### 3.3 Workspace / tools / permissions

| code | retriable | meaning |
|---|---|---|
| `WORKSPACE_REQUIRED` | no | no workspace bound |
| `PATH_OUTSIDE_WORKSPACE` | no | path escapes sandbox before an explicit outside-path permission decision, a non-permissioned compatibility call reaches the resolver, or a prompt attachment is outside its session scratch/project/attachment roots |
| `TOOL_NOT_FOUND` | no | unknown tool |
| `TOOL_DENIED` | no | permission denied / mode forbidden |
| `TOOL_TIMEOUT` | yes | tool execution timeout |
| `TOOL_FAILED` | maybe | tool executed but failed |
| `MUTATION_RETRY_BUDGET_EXHAUSTED` | yes | the repeat guard ended the turn after same-path `Edit` or shell patch failures; carries `details.kind` (`edit` or `patch-command`) and the last tool error code |
| `PROCESS_RESOURCE_EXHAUSTED` | yes | shell process could not start because the OS temporarily exhausted process resources |
| `SHELL_NOT_FOUND` | no | no effective platform shell is available after catalog fallback; message carries guidance |
| `COMMAND_SHELL_CHANGED` | no | pinned shell ID or dialect changed before execution |
| `COMMAND_SHELL_INVALID` | no | settings supplied an unknown, unavailable, or wrong-platform shell ID |
| `PERMISSION_TIMEOUT` | no | permission prompt timed out (mapped to deny) |
| `PERMISSION_REQUIRED` | no | waiting for user decision |
| `WRITE_DISABLED_IN_PLAN` | no | contract-mode hard-deny for Write |
| `EDIT_DISABLED_IN_PLAN` | no | contract-mode hard-deny for Edit |
| `PLUGIN_DISABLED_IN_PLAN` | no | contract-mode hard-deny for every plugin tool |
| `TOOL_DISABLED_IN_PLAN` | no | contract-mode hard-deny for an unknown/unlisted tool |
| `PLAN_NOT_ACTIVE` | no | a submit tool ran while no contract was being negotiated |
| `PLAN_KIND_MISMATCH` | no | `SubmitPlan` in Goal mode, or `SubmitGoal` in Plan mode |
| `PLAN_APPROVAL_REQUIRED` | no | SubmitPlan/SubmitGoal is waiting for a separate approval |
| `PLAN_APPROVAL_TIMEOUT` | no | absolute 30-minute plan approval deadline expired |
| `PLAN_APPROVAL_STALE` | no | response does not match the live proposal/session/turn/tool-call/version |
| `PLAN_APPROVAL_INTERRUPTED` | no | pending approval closed during abort, crash, or persistence failure |
| `PLAN_ARTIFACT_WRITE_FAILED` | no | host could not write exact bytes to a new `.pi/<kind>/*.md` artifact |
| `PLAN_EXECUTION_INTERRUPTED` | no | approved queued/running Plan or Goal execution stopped without replay |
| `PLAN_REQUIRES_INTERACTIVE_SESSION` | no | unattended/scheduled Plan or Goal run cannot request approval |

The `_IN_PLAN` suffix and the `PLAN_` prefix are historical: both contract modes
(Plan and Goal) share these codes rather than duplicating a `_IN_GOAL` set
(**D198**). The renderer picks its wording from the proposal's `kind`, so one
code can surface as either "Plan" or "Goal" copy.

### 3.4 Edit contract (ADR 0087)

Emitted only by `Edit`. Version and provenance failures have their own codes
because each names a different next action; reporting them as `TOOL_FAILED`
loses that. See
[18-line-anchored-edit-contract](18-line-anchored-edit-contract.md) §11.

| code | retriable | meaning |
|---|---|---|
| `EDIT_TAG_REQUIRED` | no | `tag` missing or not 4 hex digits |
| `EDIT_TAG_MISMATCH` | yes after a `Read` | tag does not hash the live file and drift recovery declined; carries the live tag and current content at the anchors |
| `EDIT_TAG_UNKNOWN` | yes after a `Read` | tag is well-formed but the session recorded no such content for the path |
| `EDIT_LINES_UNSEEN` | yes | anchors reference lines the session never displayed; carries the revealed content |
| `EDIT_PARSE_FAILED` | no | malformed op header, body row under a colonless header, missing body, or a `-`/context row |
| `EDIT_RANGE_INVALID` | no | reversed range, out-of-bounds line, overlapping ops, or duplicate anchor |
| `EDIT_BLOCK_UNRESOLVED` | no | a `N*` locator did not resolve; message names the plain-range alternative |
| `EDIT_REGISTER_EMPTY` | no | paste from an unset register |
| `EDIT_REGISTER_AMBIGUOUS` | no | anonymous paste with more than one pending anonymous capture |
| `EDIT_REPAIR_AMBIGUOUS` | no | boundary-repair candidates tied at minimum cost |
| `EDIT_NO_CHANGE` | no | the apply produced text identical to the input |
| `EDIT_AMPLIFICATION_LIMIT` | no | lowering exceeded the expansion cap |

`EDIT_LINES_UNSEEN` is retriable **without** a further `Read` when its message
reports a complete reveal: the revealed lines are merged into the session's
provenance, so the same `tag` retried unchanged applies. A truncated reveal
merges nothing and requires the re-read.

`EDIT_TAG_MISMATCH`, `EDIT_TAG_UNKNOWN`, and `EDIT_LINES_UNSEEN` each get one
free attempt per path before the repeat guard counts them, because each already
carries what the retry needs. The remaining codes count on first occurrence, and
the failure that exhausts the budget surfaces as §3.3's
`MUTATION_RETRY_BUDGET_EXHAUSTED` on the assistant row
([18-line-anchored-edit-contract](18-line-anchored-edit-contract.md) §9.3).

### 3.5 Secrets / settings

| code | retriable | meaning |
|---|---|---|
| `PROVIDER_SECRET_MISSING` | no | enabled provider requires an API key |
| `SECRET_STORE_UNAVAILABLE` | maybe | OS secure storage unavailable (reserved) |
| `SETTINGS_INVALID` | no | settings payload invalid (reserved) |

### 3.6 Plugins

| code | retriable | meaning |
|---|---|---|
| `PLUGIN_NOT_FOUND` | no | plugin id missing (reserved) |
| `PLUGIN_INVALID` | no | manifest/package invalid |
| `PLUGIN_LOAD_FAILED` | maybe | enable/load failed |
| `PLUGIN_DISABLED` | no | plugin disabled (reserved) |
| `PLUGIN_PERMISSION_DENIED` | no | plugin lacks declared/granted permission (reserved) |
| `PLUGIN_COMMAND_NOT_FOUND` | no | command id missing (reserved) |
| `PLUGIN_CRASHED` | yes | plugin runtime crashed (reserved) |
| `PLUGIN_CONTRACT_MISMATCH` | no | unsupported manifest/api version (reserved) |

### 3.7 Reserved detail codes (not yet emitted)

Finer-grained provider/tool distinctions documented for future mapping.
Until emitted, implementations use the canonical parent code shown.

| reserved code | canonical parent today | notes |
|---|---|---|
| `PROVIDER_BASE_URL_INVALID` | `PROVIDER_ERROR` | endpoint invalid (400) |
| `PROVIDER_PROTOCOL_MISMATCH` | `PROVIDER_ERROR` | wrong protocol profile |
| `PROVIDER_MODEL_NOT_FOUND` | `MODEL_NOT_CONFIGURED` | unknown model id (404) |
| `PROVIDER_TIMEOUT` | `TIMEOUT` | network/server timeout (retriable) |
| `PROVIDER_UNSUPPORTED_CAPABILITY` | `PROVIDER_ERROR` | tools/vision unsupported |
| `PROVIDER_DISABLED` | `MODEL_NOT_CONFIGURED` | provider disabled |
| `WORKSPACE_PATH_DENIED` | `PATH_OUTSIDE_WORKSPACE` | ignore/denylist block |
| `TOOL_BINARY_CONTENT` | `TOOL_FAILED` | refused binary dump |

Historical aliases (never use in new code): `PROVIDER_AUTH_FAILED` →
`PROVIDER_UNAUTHORIZED`; `PROVIDER_STREAM_INTERRUPTED` → `STREAM_FAILED`;
`WORKSPACE_OUTSIDE_ROOT` → `PATH_OUTSIDE_WORKSPACE`; `SECRET_MISSING` →
`PROVIDER_SECRET_MISSING`; `SHELL_UNAVAILABLE` → `SHELL_NOT_FOUND`;
`SHELL_IDENTITY_STALE` → `COMMAND_SHELL_CHANGED`; `PLAN_APPROVAL_EXPIRED` →
`PLAN_APPROVAL_TIMEOUT`. Truncation is not an error: a bounded tool result
carries a marker naming which end survived and where the rest is, or reports
the bounded window in sibling result fields
(see [16-tool-result-limits](16-tool-result-limits.md)).

## 4. Mapping rules

### Host RPC numeric → AppError.code
See `06-host-rpc-protocol.md` numeric table.  
Example: host `1004` → `TOOL_DENIED`.

### Provider exceptions
Node sidecar maps provider SDK errors into:

- `PROVIDER_UNAUTHORIZED`
- `PROVIDER_RATE_LIMITED`
- `MODEL_NOT_CONFIGURED` (provider rejects the selected model with 404)
- `PROVIDER_ERROR`
- `NETWORK_ERROR`
- `STREAM_FAILED`

An exact `terminated` provider message and equivalent premature stream-close
messages map to `STREAM_FAILED`. A request-setup or post-response
`PROVIDER_RATE_LIMITED` uses the shared runtime budget: five retries after the
initial attempt, with setup and stream failures counting together. Non-429
transient failures — `STREAM_FAILED`, `NETWORK_ERROR`, `TIMEOUT`, and retryable
`PROVIDER_ERROR` such as an upstream gateway 502/503/504 — share their own
bounded budget of four retries after the initial attempt, also counted together
across setup and stream, and separate from the 429 budget. Both budgets are
abortable. The 429 path honors `retry-after-ms`, `retry-after` seconds, and
HTTP-date headers before client backoff and caps a wait at 30 seconds; the
non-429 path applies the same precedence with an 8-second cap and otherwise
waits 1, 2, 4, then 8 seconds. Only the failed request is replayed; the session
and its tool state are untouched. A non-retryable `PROVIDER_ERROR` from a
malformed 400/422 request never enters either budget.

### Permission timeout
UI/host timeout emits `PERMISSION_TIMEOUT` internally, tool result presented as denied (`TOOL_DENIED`) to agent.

### Shell and Plan/Goal checkpoint failures

`SHELL_NOT_FOUND` is returned only when catalog fallback finds no available
platform shell. `COMMAND_SHELL_CHANGED` never retries with a different shell;
the turn must obtain a fresh effective ID/dialect. `PLAN_ARTIFACT_WRITE_FAILED`
never creates an approval row. `PLAN_APPROVAL_TIMEOUT` applies only to the
absolute pending deadline;
`PLAN_EXECUTION_INTERRUPTED` identifies an already-approved queued/running
execution interrupted by abort or host recovery. `PLAN_KIND_MISMATCH` is a
terminating tool error like `PLAN_NOT_ACTIVE`: the submit tool ran against the
wrong contract, so no artifact is written and no approval row is created.

## 5. UI handling guidelines

| class | UI behavior |
|---|---|
| auth/config (`PROVIDER_SECRET_MISSING`, `MODEL_NOT_CONFIGURED`) | assistant error message with settings CTA |
| permission denials | inline tool card state |
| retriable provider/network | assistant error message with diagnostic details; session-scoped failed-turn recovery card provides retry |
| internal/host unavailable | degraded banner + recovery tip |

Message-bound provider failures never use a toast or floating global banner.
A `PROVIDER_RATE_LIMITED` failure remains invisible while its bounded retry
budget is available; only exhaustion renders the assistant error and lifecycle
error. The assistant error message shows a localized summary and stable code,
with an accessible details disclosure containing the redacted provider response,
provider ID, and model ID. Provider detail is capped at 600 characters and
common credential/header values are redacted before event emission or
persistence. When available, the details disclosure and timing logs may also
show bounded `phase`, `providerStatus`, `providerCode`, `providerWaitMs`,
`streamMs`, and `retryAttempt` fields. The assistant error card offers a localized
Continue action that resends the continuation prompt (`继续当前任务` /
`Continue the current task`) in the same session without truncating the failed
turn. Regenerate remains available from the session-scoped failed-turn recovery
card rather than the assistant error card.

## 6. i18n key convention

```text
errors.<code>
errors.<code>.action
```

Examples:

- `errors.PROVIDER_SECRET_MISSING`
- `errors.PROVIDER_SECRET_MISSING.action`
- `errors.HOST_UNAVAILABLE`

## 7. Acceptance

1. Every IPC failure returns `AppError.code`
2. No raw untyped string-only failures on main paths
3. Plan/Goal hard-denies use explicit tool-specific codes; Bash is never denied
   by either contract mode solely because of the operating mode and instead
   follows permission policy
4. Host numeric codes map to stable string codes
5. Invalid shell settings, no-effective-shell/stale-pin, artifact-write,
   expiry, scheduled-rejection, and restart-interruption paths map to stable
   codes; only the documented pre-turn catalog fallback is allowed and no work
   is replayed
