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

The desktop test suite (`apps/desktop/test/error-code-registry.test.mjs`) verifies
that every `ErrorCodes` entry appears in this document and that every
`errorCode` host-core emits from its RPC dispatcher and native tools is
registered; reserved codes in §3.7 remain intentionally absent from
`ErrorCodes` until an implementation emits them.

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
| `INVALID_PARAMS` | no | host-core RPC parameter validation failed (numeric `1002`); the sidecar and renderer surface it unchanged |
| `UNAUTHORIZED` | no | capability/auth boundary rejected call |
| `NOT_FOUND` | no | entity not found |
| `SESSION_NOT_FOUND` | no | a session-scoped RPC (including `tools.execute`) named a session the host does not have; an unknown id never inherits the global workspace |
| `CONFLICT` | maybe | state conflict / busy resource |
| `UNSUPPORTED` | no | the operation has no implementation on this surface, e.g. a trusted-extension prompt while no desktop window can show it (spec 16 §9) |
| `FORBIDDEN` | no | RACP: the principal's roles do not admit the method (spec 19 §13) |
| `METHOD_NOT_FOUND` | no | RACP: unknown method on this Host, e.g. `host/list` without a Gateway |
| `IDEMPOTENCY_CONFLICT` | no | a queue or turn idempotency key was reused with different input (D386) |
| `CURSOR_EXPIRED` | no | RACP: the replay cursor is older than the retained window; resubscribe from a snapshot |
| `CLIENT_TOO_SLOW` | yes | RACP: the client fell behind the event stream and was disconnected |
| `APPROVAL_EXPIRED` | no | RACP: the approval deadline passed before an answer arrived |
| `APPROVAL_STALE` | no | RACP: the approval was already settled or belongs to an older turn |
| `PAYLOAD_TOO_LARGE` | no | RACP: a frame exceeded the negotiated size bound |
| `TIMEOUT` | yes | generic timeout |
| `NETWORK_POLICY_BLOCKED` | no | the main-process public-network guard refused a fetch because it *judged* the target: the URL failed the syntactic public-HTTPS check, or the local DNS lookup returned an address the policy classifies as non-public — including a fake-IP placeholder a local proxy invented (ADR 0243). A desktop-only code; a refusal is a verdict, so retrying cannot succeed until the address changes. A resolver that returned no answer at all is `NETWORK_RESOLVE_FAILED` instead (issue #419). |
| `NETWORK_RESOLVE_FAILED` | yes | the main-process public-network guard could not classify the target host: the local DNS lookup returned no answer, or threw before returning one. The request is refused exactly as a policy refusal is, but no address was judged, so no page or log may report it as an address-check decision. Distinct from `NETWORK_ERROR`, which is a failure of the request itself. Retriable: a resolver or proxy that starts answering the same host makes the same request succeed (ADR 0243, issue #419). |
| `HOST_SHUTTING_DOWN` | yes | the host received EOF and is draining; the call was refused rather than started |
| `RATE_LIMITED` | yes | a per-caller host budget (plugin session import, batch operations) was exceeded inside its window |
| `LIMIT_EXCEEDED` | no | a payload exceeded a fixed host bound (item count, byte size, or a 64 MiB NDJSON request line) and was refused |


`HOST_UNAVAILABLE` is reserved for a missing or broken host process/transport,
not ordinary admission pressure. RPC capacity returns `HOST_OVERLOADED`, and
an admitted shell that cannot start because the OS is temporarily out of
process resources returns `PROCESS_RESOURCE_EXHAUSTED`. Host-core's control
stdio is isolated from Tokio's dynamic blocking pool so the latter condition
does not turn temporary thread pressure into a host process exit.

### 3.2 Agent / session

| code | retriable | meaning |
|---|---|---|
| `AGENT_BUSY` | no | session already has active turn; leftover subagents after a terminal parent error do not keep the session busy (D352) |
| `AGENT_NOT_FOUND` | no | session missing |
| `TURN_NOT_FOUND` | no | turn id invalid |
| `TURN_ABORTED` | no | turn aborted by user/system |
| `MODEL_NOT_CONFIGURED` | no | no usable model selected, or provider rejects the selected model as unknown |
| `PROVIDER_ERROR` | yes | upstream provider failure; a retryable one (5xx gateway) gets up to ten same-turn retries, a malformed 400/422 request is terminal |
| `PROVIDER_UNAUTHORIZED` | no | bad/missing provider credentials |
| `PROVIDER_RATE_LIMITED` | yes | provider rate limited; runtime silently retries up to ten times across setup/stream before the terminal event |
| `CONTEXT_TOO_LARGE` | no | prompt/context still exceeds the safe model budget after recovery, the second provider overflow occurred, or automatic recovery is disabled |
| `CONTEXT_COMPACTION_FAILED` | no | automatic retained-tail recovery could not prepare, persist, or fit a checkpoint, or manual checkpoint summary generation / durable append failed; the guarded next provider request does not start |
| `STREAM_FAILED` | yes | provider stream was terminated, closed prematurely, or otherwise ended before a complete response; up to ten same-turn retries may precede the terminal event |
| `EMPTY_MODEL_RESPONSE` | yes | the model ended its turn with no tool call and no visible text twice: once as streamed, once after the automatic re-run; the first reply to a Host-ledger completion notice is exempt (spec 02-agent-runtime §5e, D446) |
| `PROMPT_ENHANCEMENT_EMPTY` | no | the one-shot enhancement model returned no text |
| `SPEECH_NOT_CONFIGURED` | no | host speech ASR or TTS is not bound in settings |
| `SPEECH_PROTOCOL_UNSUPPORTED` | no | the speech protocol is unknown or does not support this role |
| `SPEECH_INPUT_TOO_LARGE` | no | speech input exceeds 25 MB |
| `SUBAGENT_IDLE_TIMEOUT` | no | withdrawn (D328): idle watchdogs are not armed; the code remains for stored results |
| `SUBAGENT_DURATION_TIMEOUT` | no | withdrawn (D328): duration watchdogs are not armed; the code remains for stored results |
| `SUBAGENT_CONTEXT_OVERFLOW` | no | a delegate's own model context exceeded its safe budget and neither automatic turn-boundary compaction nor the degraded retry that keeps only the task brief and the most recent messages brought it back below the limit; the failure names the actionable recovery instead of the provider's overflow text |
### 3.3 Workspace / tools / permissions

| code | retriable | meaning |
|---|---|---|
| `WORKSPACE_REQUIRED` | no | no workspace bound |
| `PATH_OUTSIDE_WORKSPACE` | no | path escapes sandbox before an explicit outside-path permission decision, or a prompt attachment is outside its session scratch/project/attachment roots |
| `WORKSPACE_PATH_DENIED` | no | an explicit `Read`/`Write`/`Edit` path hit the always-on security denylist (private keys, `.env` files, credential bundles, `.git/objects`); an outside-path grant does not lift it (spec 15 §3) |
| `READ_PATH_IS_DIRECTORY` | no | `Read` was given a directory; the result carries a `Glob` suggestion |
| `TOOL_BINARY_CONTENT` | no | `Read` refused to dump a binary file into the model context |
| `TOOL_NOT_FOUND` | no | unknown tool |
| `TOOL_DENIED` | no | permission denied / mode forbidden |
| `TOOL_TIMEOUT` | yes | tool execution timeout |
| `TOOL_FAILED` | maybe | tool executed but failed |
| `TOOL_ABORTED` | no | the tool was cancelled by a user stop or a turn abort before it finished |
| `MUTATION_RETRY_BUDGET_EXHAUSTED` | yes | the repeat guard ended the turn after same-path `Edit` or shell patch failures; carries `details.kind` (`edit` or `patch-command`), the last tool error code, and a class-specific `details.recovery` hint |
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
| `PLAN_NOT_FOUND` | no | no approval row matches the proposal id |
| `PLAN_SESSION_NOT_FOUND` | no | the Plan/Goal RPC named a session the host does not have |
| `PLAN_WORKSPACE_REQUIRED` | no | the session has no persisted project; temporary sessions cannot enter Plan or Goal |
| `PLAN_ALREADY_ACTIVE` | no | the session already has a contract being negotiated |
| `PLAN_ALREADY_PENDING` | no | a submit arrived while an approval for the same turn is still pending |
| `PLAN_ALREADY_RESOLVED` | no | a second approve/reject reached an already-resolved approval |
| `PLAN_APPROVAL_CONFLICT` | no | the approval row changed underneath a version-guarded update |
| `PLAN_INVALID_ACTION` | no | the approval response is neither `approve` nor `reject` |
| `PLAN_INVALID_ARGUMENT` | no | submit/resolve arguments failed validation |
| `PLAN_PERMISSION_MODE_REQUIRED` | no | approve did not select `ask`, `accept-edits`, or `auto` |
| `PLAN_PERMISSION_MODE_INVALID` | no | the selected permission mode is not one of the three |
| `PLAN_MARKDOWN_TOO_LARGE` | no | the submitted Markdown exceeds the artifact size bound |
| `PLAN_REJECTED` | no | the user rejected the proposal; the turn ends without execution |
| `PLAN_SUBMIT_FAILED` | maybe | the host could not record the proposal |
| `PLAN_CONFIGURATION_BLOCKED` | no | `session.configure` was refused while a proposal or execution is live |
| `PLAN_ARTIFACT_INVALID` | no | the checkpoint artifact failed validation before execution |
| `PLAN_ARTIFACT_NOT_READY` | no | execution was claimed before the artifact was durably written |
| `PLAN_ARTIFACT_PATH_UNSAFE` | no | the artifact path escaped `<workspaceRoot>/.pi/<kind>/` |
| `PLAN_ARTIFACT_COLLISION_LIMIT` | no | the host ran out of unique artifact names |
| `PLAN_ARTIFACT_HASH_MISMATCH` | no | artifact bytes no longer match the recorded hash at execution time |
| `PLAN_EXECUTION_ACTIVE` | no | an approved execution is already running for the session |
| `PLAN_EXECUTION_NOT_FOUND` | no | no queued execution matches the claim |
| `PLAN_EXECUTION_ALREADY_CLAIMED` | no | another claimant took the queued execution first |
| `PLAN_EXECUTION_STALE` | no | the execution epoch no longer matches the live session |
| `PLAN_EXECUTION_STATUS_INVALID` | no | a status transition was not allowed from the current state |
| `PLAN_EXECUTION_CONFLICT` | no | the execution row changed underneath a version-guarded update |
| `PLAN_EXECUTION_FAILED` | maybe | the approved execution ended in an error |
| `PLAN_INTERNAL` | maybe | a Plan/Goal host failure with no finer classification |
| `WRITE_DISABLED_IN_CHAT` | no | historical (pre-D188 Chat profile); registered for stored transcripts, no longer emitted |
| `BASH_DISABLED_IN_CHAT` | no | historical (pre-D188 Chat profile); registered for stored transcripts, no longer emitted |

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
| `EDIT_PARSE_FAILED` | no | malformed op header, body row under a colonless header, missing body, or a `-`/context row; the host message identifies the required syntax when possible |
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
Its `details.recovery` value distinguishes syntax correction from the fresh-read
path, so a follow-up does not blindly re-read a file when the payload itself is
malformed.

### 3.5 Secrets / settings

| code | retriable | meaning |
|---|---|---|
| `PROVIDER_SECRET_MISSING` | no | enabled provider requires an API key |
| `MODEL_ALIAS_TOO_LONG` | no | configured model alias exceeds 60 Unicode characters |
| `SECRET_STORE_UNAVAILABLE` | maybe | OS secure storage unavailable (reserved) |
| `SETTINGS_INVALID` | no | settings payload invalid (reserved) |

### 3.6 Plugins

| code | retriable | meaning |
|---|---|---|
| `PLUGIN_NOT_FOUND` | no | plugin id missing |
| `PLUGIN_INVALID` | no | manifest/package invalid |
| `PLUGIN_LOAD_FAILED` | maybe | enable/load failed |
| `PLUGIN_DISABLED` | no | plugin disabled (reserved) |
| `PLUGIN_PERMISSION_DENIED` | no | plugin lacks the declared and granted permission the call needs |
| `PLUGIN_INTEGRITY` | no | package checksum or signature did not match the catalog entry |
| `PLUGIN_NETWORK` | yes | marketplace download or catalog fetch failed |
| `PLUGIN_HOST_TOO_OLD` | no | the package's `engines.piDesktop` range excludes this host |
| `PLUGIN_MARKET_INVALID` | no | the marketplace catalog is malformed or missing required release fields |
| `PLUGIN_MARKET_UNTRUSTED_HOST` | no | the catalog or package URL is outside the trusted marketplace hosts |
| `PLUGIN_MARKET_YANKED` | no | the requested release was withdrawn from the catalog |
| `PLUGIN_MARKET_NOT_PUBLISHED` | no | the platform has the version and is not offering it yet |
| `PLUGIN_MARKET_ARCHIVED` | no | the plugin was withdrawn from the platform |
| `PLUGIN_MARKET_NOT_FOUND` | no | the platform does not have that plugin or version |
| `PLUGIN_MARKET_RATE_LIMITED` | yes | the download endpoint asked the client to wait |
| `PLUGIN_MARKET_NO_SOURCE` | maybe | no distribution target can serve the package |
| `PLUGIN_CANCELLED` | no | the user cancelled an install while it was downloading |
| `MCP_INVALID` | no | a user MCP server definition failed validation |
| `SKILL_INVALID` | no | a user skill document failed validation |
| `SUBAGENT_INVALID` | no | a user subagent document failed validation |
| `CAPABILITY_INVALID` | no | an agent capability root or scope setting failed validation |
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

`WORKSPACE_PATH_DENIED` and `TOOL_BINARY_CONTENT` left this table when the
host started emitting them (§3.3).

Historical aliases (never use in new code): `PROVIDER_AUTH_FAILED` →
`PROVIDER_UNAUTHORIZED`; `PROVIDER_STREAM_INTERRUPTED` → `STREAM_FAILED`;
`WORKSPACE_OUTSIDE_ROOT` → `PATH_OUTSIDE_WORKSPACE`; `SECRET_MISSING` →
`PROVIDER_SECRET_MISSING`; `SHELL_UNAVAILABLE` → `SHELL_NOT_FOUND`;
`SHELL_IDENTITY_STALE` → `COMMAND_SHELL_CHANGED`; `PLAN_APPROVAL_EXPIRED` →
`PLAN_APPROVAL_TIMEOUT`. Truncation is not an error: a bounded tool result
carries a marker naming which end survived and where the rest is, or reports
the bounded window in sibling result fields
(see [16-tool-result-limits](16-tool-result-limits.md)).

### 3.8 Remote control (RACP-WS / SSH bootstrap)

Emitted by the desktop's remote-host client and the `pi-host` server when a
session lives on a paired remote machine driven over `RACP-WS`
(see [19-remote-agent-control-protocol](19-remote-agent-control-protocol.md),
[../05-security/02-remote-control-security](../05-security/02-remote-control-security.md),
ADR 0285). The renderer never sees the local/remote split beyond a badge; these
codes surface through the same error object as any other call.

| code | retriable | meaning |
|---|---|---|
| `HOST_DISCONNECTED` | yes | the remote host connection dropped; in-flight calls are rejected and the client reconnects and resubscribes by cursor |
| `HOST_BOOTSTRAP_FAILED` | no | provisioning the remote `pi-host` over SSH failed (download, checksum mismatch, or `install.sh`); `details.reason` names the stage |
| `HOST_VERSION_MISMATCH` | no | the remote `pi-host` version does not match the desktop; the desktop refuses to drive an incompatible host |
| `REMOTE_AUTH_FAILED` | no | the device or pairing token was rejected on the RACP-WS upgrade |
| `REMOTE_CONNECTION_FAILED` | yes | the RACP-WS transport could not connect (non-loopback URL, refused socket) |
| `REMOTE_FORWARD_FAILED` | yes | the SSH loopback port forward could not be established |
| `REMOTE_PATH_NOT_FOUND` | no | a remote project/workspace path does not exist on the host |
| `REMOTE_PATH_FORBIDDEN` | no | a remote path is outside the host's permitted roots |
| `PAIRING_FAILED` | no | `connection/pair` could not mint a device credential |
| `PAIRING_TOKEN_EXPIRED` | no | the single-use pairing token expired before pairing completed |
| `CAPABILITY_UNAVAILABLE` | no | an operation was requested for a capability the host advertised as unavailable (e.g. attachments, tool relay) |

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
`PROVIDER_RATE_LIMITED` uses the shared runtime budget: ten retries after the
initial attempt, with setup and stream failures counting together. Non-429
transient failures — `STREAM_FAILED`, `NETWORK_ERROR`, `TIMEOUT`, and retryable
`PROVIDER_ERROR` such as an upstream gateway 502/503/504 — share their own
bounded budget of ten retries after the initial attempt, also counted together
across setup and stream, and separate from the 429 budget. Both budgets are
abortable and reset after a complete successful model response, including a
tool-call response, in both the main session and builtin subagents. Headers,
partial output, and phase changes do not replenish them. Terminal exhaustion
reports `retryAttempt: 10` from the applicable budget even after retry activity
cleanup. The 429 path honors `retry-after-ms`, `retry-after` seconds, and
HTTP-date headers before client backoff and caps a wait at 30 seconds; the
non-429 path applies the same precedence with an 8-second cap and otherwise
waits 1, 2, 4, then remains at 8 seconds for later retries. Only the failed
request is replayed; the session and its tool state are untouched. A
non-retryable `PROVIDER_ERROR` from a
malformed 400/422 request never enters either budget. The persisted
`infiniteProviderRetry` setting is false by default; when true it removes only
the retry-count ceiling for the admitted transient/network classes (including
429). Backoff, `Retry-After`, cancellation, and terminal classification remain
unchanged, and the setting may continue API usage until the user stops the turn.

A `NETWORK_ERROR` carries the failing transport layer as bounded `details`:
`networkCategory` (`dns`, `tls`, `timeout`, `refused`, `unreachable`, `reset`,
`proxy`, or `unknown` when nothing survived), `networkCode` (the errno, e.g.
`ENOTFOUND`, `ECONNRESET`, `EPROTO`, `UND_ERR_SOCKET`), and, when the transport
reported them, `networkSyscall` and `networkHost`. Only the bare hostname is
kept — never a URL, port, path, query, or credential — and `providerCode` is
omitted when it would repeat `networkCode`. Per-layer codes (`DNS_ERROR`,
`TLS_ERROR`, `SOCKET_RESET`, …) are deliberately not introduced: the category
splits the layers without adding user-visible codes and locale strings for
each of them.

The diagnosis is read from the live cause chain at the fetch boundary, not only
from the provider message. pi-ai flattens a rejected request into
`errorMessage`, so by the time classification runs the errno undici keeps in
`error.cause` is already gone and a bare `fetch failed` can only be reported as
`networkCategory: unknown`; the fetch wrapper still holds the original Error and
supplies the same validated fields from it. A captured cause also settles the
phase: the fault is reported as `phase: request` because no response ever
arrived, which is what distinguishes it from a stream that ended mid-response.
`networkRoute` (`direct`, `environment-proxy`, `http-proxy`, `socks5-proxy`)
names the hop the request was taking, so a failure at the proxy is readable
without guessing from an errno.

When one origin fails this way repeatedly inside a turn — twice in a row,
without any response — the provider transport is rebuilt before the next attempt
instead of replaying into the same undici pool. The rebuild is process-wide and
deliberately bounded: one rebuild per streak, at most one every 30 seconds, and
never for a `dns` failure, which a fresh pool cannot change. The replacement is
installed before the previous dispatcher is closed, and the previous one is
closed gracefully, so a request another session already dispatched finishes on
the pool it started on. The route in effect is reproduced, never downgraded to a
direct connection.

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
| retriable provider/network | assistant error message with diagnostic details and Continue; the session-scoped failed-turn recovery card is a fallback only when no structured assistant error is present |
| internal/host unavailable | degraded banner + recovery tip |

Message-bound provider failures never use a toast or floating global banner.
A `PROVIDER_RATE_LIMITED` failure remains invisible while its bounded retry
budget is available; only exhaustion renders the assistant error and lifecycle
error. The assistant error message shows a localized summary and stable code,
with an accessible details disclosure containing the redacted provider response,
provider ID, and model ID. Provider detail is capped at 600 characters and
common credential/header values are redacted before event emission or
persistence. When available, the details disclosure may also show bounded
`phase`, `providerStatus`, `providerCode`, `providerWaitMs`, `streamMs`,
`retryAttempt`, `networkCategory`, `networkCode`, `networkSyscall`,
`networkHost`, `networkRoute`, `requestMessages`, `requestBytes`, and
`compactionGeneration`
fields. The request fields are counts and byte sizes only and the compaction
field is the checkpoint generation counter; none of them carries message
content. While a transient provider failure retries, the activity indicator's
reason popover shows the localized summary, the stable code, and — for a
network failure — the transport errno (`NETWORK_ERROR · ENOTFOUND`), so the
failing layer is visible during the retry loop as well as in the log record.
The assistant error card offers a localized
Continue action that resends the continuation prompt (`继续当前任务` /
`Continue the current task`) in the same session without truncating the failed
turn. The session-scoped failed-turn recovery card is used only when no
structured assistant error is present; neither failure surface offers
Regenerate.

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

### Certificate verification failures (issue #714)

`NETWORK_ERROR` is non-retriable when `details.networkCode` is a recognized
certificate verification failure, including an untrusted/self-signed chain,
an expired/not-yet-valid certificate, or `ERR_TLS_CERT_ALTNAME_INVALID`.
A concrete certificate cause takes precedence over generic socket/proxy
wrapper codes. Captured fetch causes apply this policy after adapter error
flattening as well as during direct classification. Unknown and non-certificate
TLS/protocol errors retain existing recovery behavior.

The transcript keeps the stable error code, transport errno and raw details,
but uses localized certificate guidance instead of the generic connectivity
summary. It asks the user to check the certificate, clock, and trusted roots
used by security software/proxies, then restart after changing trust. It does
not claim that interception is the only possible cause or offer a TLS bypass.
Manual Continue remains available after the cause is corrected.
