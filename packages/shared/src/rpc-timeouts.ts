export const DEFAULT_RPC_TIMEOUT_MS = 130_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const COMMAND_RPC_BUFFER_MS = 10_000;
/**
 * host-core's admission queue wait: what a call costs when its tool class is
 * saturated. It is spent after the permission gate and before the tool runs.
 * Mirrors `TOOL_QUEUE_WAIT_MS` in
 * `crates/host-core/src/tool_budget.rs`.
 */
export const TOOL_QUEUE_WAIT_MS = 30_000;
/**
 * host-core's dispatch budget for `plugin_*` / `mcp_*` tools, which Electron
 * main executes. It outlasts every budget Electron enforces inside it: the
 * plugin tool budget (110s) and the widest MCP leg, a lazy handshake plus the
 * whole `tools/list` traversal plus the call (10s + 30s + 100s). Mirrors
 * `DESKTOP_TOOL_DISPATCH_TIMEOUT_MS` in `crates/host-core/src/tools/mod.rs`;
 * the transport no longer adds this budget to a permission wait.
 */
export const DESKTOP_TOOL_DISPATCH_TIMEOUT_MS = 150_000;
/**
 * The sidecar's zero-event stream watchdog. Mirrors
 * `STREAM_IDLE_TIMEOUT_DEFAULT_MS` in
 * `packages/agent-runtime/src/provider-retry.ts`: a provider stream that emits
 * nothing for this long is ended as a retriable failure instead of leaving the
 * caller hung on a connection the provider never closes.
 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000;
/**
 * Retries the summary request may claim after its first failure. Mirrors
 * `COMPACTION_SUMMARY_MAX_RETRIES` in
 * `packages/agent-runtime/src/compaction-summary-input.ts`, whose waits are
 * 2s + 4s + 8s.
 */
export const COMPACTION_SUMMARY_MAX_RETRIES = 3;
export const COMPACTION_SUMMARY_RETRY_BUDGET_MS = 14_000;
/**
 * `agent.compact` is a blocking RPC that spends a whole model request inside
 * the sidecar: pi serializes the conversation into one summary prompt, streams
 * the summary, and may retry a transient failure. No part of that budget is a
 * wall clock the transport can read, so this deadline is derived from the
 * ceilings the sidecar does enforce — an attempt that stops producing events is
 * cut by its stream watchdog, and the retries add at most
 * `COMPACTION_SUMMARY_RETRY_BUDGET_MS` of backoff:
 *
 *   (1 + retries) * stream watchdog + retry backoff + transport slack
 *
 * With the flat 130s default Electron gave up while the sidecar was still
 * summarizing a large context (~158s), reported a failed compaction, and the
 * sidecar persisted that checkpoint anyway (issue #795). Deliberately
 * per-method: a wider global default would also hide a genuinely lost reply on
 * every other call.
 */
export const AGENT_COMPACT_RPC_TIMEOUT_MS =
  (1 + COMPACTION_SUMMARY_MAX_RETRIES) * STREAM_IDLE_TIMEOUT_MS +
  COMPACTION_SUMMARY_RETRY_BUDGET_MS +
  COMMAND_RPC_BUFFER_MS;

/**
 * `worktree.delegate.create` / `.settle` (ADR 0329) checkpoint and merge in a
 * session worktree: up to 5s waiting for the session to go quiet, up to
 * `TOOL_QUEUE_WAIT_MS` for its write permit, then a handful of git commands,
 * each bounded by host-core. Under the flat default the runtime gave up while
 * the host was still merging and reported work as kept that had landed.
 */
export const WORKTREE_DELEGATE_RPC_TIMEOUT_MS = 10 * 60_000;

/**
 * `configSync.syncNow` is a Host-owned multi-step operation. It has no
 * whole-request deadline: individual S3 requests retain their own bounds, and
 * navigating away from Settings only detaches the renderer from the request.
 * Host/process shutdown remains the lifecycle boundary.
 */


/**
 * Whether an error came from a transport deadline rather than from the peer.
 * `host-process`, `agent-sidecar`, and `parent host proxy` are the only
 * producers of these messages.
 */
export function isRpcTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:host|sidecar|parent host proxy) RPC timeout: /.test(message);
}

/**
 * Return the transport deadline for an RPC call. `configSync.syncNow` is
 * Host-owned and has no aggregate deadline; individual S3 requests keep their
 * own bounds. Renderer navigation does not cancel the Main/Host request, while
 * process shutdown remains the lifecycle boundary. Other methods keep their
 * explicit ceilings.
 */
export function rpcTimeoutMs(
  method: string,
  _params: unknown,
): number | undefined {
  if (method === "agent.compact") return AGENT_COMPACT_RPC_TIMEOUT_MS;
  if (method === "worktree.delegate.create" || method === "worktree.delegate.settle") {
    return WORKTREE_DELEGATE_RPC_TIMEOUT_MS;
  }
  if (method === "configSync.syncNow") return undefined;
  if (method === "tools.execute" || method === "tools.workspaceExecute") return undefined;
  return DEFAULT_RPC_TIMEOUT_MS;
}
