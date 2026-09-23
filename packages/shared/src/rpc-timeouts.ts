import { IMAGE_BATCH_TIMEOUT_MS } from "./image-generation.js";

export const DEFAULT_RPC_TIMEOUT_MS = 130_000;
export const PERMISSION_TIMEOUT_MS = 120_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const COMMAND_RPC_BUFFER_MS = 10_000;
export const DEFAULT_BASH_RPC_TIMEOUT_MS =
  PERMISSION_TIMEOUT_MS + DEFAULT_COMMAND_TIMEOUT_MS + COMMAND_RPC_BUFFER_MS;
/**
 * host-core's admission queue wait: what a call costs when its tool class is
 * saturated. It is spent after the permission gate and before the tool runs, so
 * a transport deadline that omits it can still give up before host-core reports
 * an outcome. Mirrors `TOOL_QUEUE_WAIT_MS` in
 * `crates/host-core/src/tool_budget.rs`.
 */
export const TOOL_QUEUE_WAIT_MS = 30_000;
/**
 * host-core's dispatch budget for `plugin_*` / `mcp_*` tools, which Electron
 * main executes. It outlasts every budget Electron enforces inside it: the
 * plugin tool budget (110s) and the widest MCP leg, a lazy handshake plus the
 * whole `tools/list` traversal plus the call (10s + 30s + 100s). Mirrors
 * `DESKTOP_TOOL_DISPATCH_TIMEOUT_MS` in `crates/host-core/src/tools/mod.rs`.
 */
export const DESKTOP_TOOL_DISPATCH_TIMEOUT_MS = 150_000;
export const DEFAULT_DESKTOP_TOOL_RPC_TIMEOUT_MS =
  PERMISSION_TIMEOUT_MS +
  TOOL_QUEUE_WAIT_MS +
  DESKTOP_TOOL_DISPATCH_TIMEOUT_MS +
  COMMAND_RPC_BUFFER_MS;
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
 * `configSync.syncNow` runs a whole sync in one request: a sequence of network
 * round trips whose steps the host reports through `configSync.progress`. The
 * host cannot cancel a run that is already under way and keeps going after a
 * transport deadline expires, so the progress events are the liveness signal
 * and the deadline only exists to stop a promise hanging forever when the
 * response is genuinely lost. No part of the run has a wall clock the
 * transport could read, so this is a ceiling for the whole run, not a measured
 * budget.
 */
export const CONFIG_SYNC_RPC_TIMEOUT_MS = 1_800_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDesktopDispatchedTool(toolName: unknown): boolean {
  return (
    typeof toolName === "string" &&
    (toolName.startsWith("plugin_") || toolName.startsWith("mcp_"))
  );
}

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
 * Return the transport deadline for an RPC call. Bash and desktop-dispatched
 * (`plugin_*` / `mcp_*`) tools include the waits host-core can spend before it
 * reports an outcome — the permission gate, the admission queue, and the
 * effective execution timeout — plus transport slack, so the transport never
 * gives up before host-core reports its own timeout. A manual context
 * checkpoint carries the same property against the sidecar's summary request
 * (`AGENT_COMPACT_RPC_TIMEOUT_MS`), and a manual cloud sync carries it against
 * the whole remote run (`CONFIG_SYNC_RPC_TIMEOUT_MS`). Every call has a finite
 * deadline so a lost response cannot leave a pending promise forever.
 */
export function rpcTimeoutMs(
  method: string,
  params: unknown,
): number {
  if (method === "agent.compact") return AGENT_COMPACT_RPC_TIMEOUT_MS;
  if (method === "configSync.syncNow") return CONFIG_SYNC_RPC_TIMEOUT_MS;
  if (method !== "tools.execute") return DEFAULT_RPC_TIMEOUT_MS;

  const input = isRecord(params) ? params : undefined;
  if (input?.toolName === "GenerateImages") return IMAGE_BATCH_TIMEOUT_MS + PERMISSION_TIMEOUT_MS + TOOL_QUEUE_WAIT_MS + COMMAND_RPC_BUFFER_MS;
  if (isDesktopDispatchedTool(input?.toolName)) {
    return executionRpcTimeoutMs(
      input?.timeoutMs,
      DEFAULT_DESKTOP_TOOL_RPC_TIMEOUT_MS,
      TOOL_QUEUE_WAIT_MS,
    );
  }
  if (input?.toolName !== "Bash") return DEFAULT_RPC_TIMEOUT_MS;
  if (input?.timeoutMs === undefined) return DEFAULT_BASH_RPC_TIMEOUT_MS;
  // Bash keeps the arithmetic it shipped with (permission + command + slack):
  // the admission queue wait is deliberately not added to that path here, so
  // its existing deadline is unchanged by this change.
  return executionRpcTimeoutMs(input.timeoutMs, DEFAULT_BASH_RPC_TIMEOUT_MS);
}

/**
 * Permission wait + optional admission queue wait + execution timeout + slack,
 * or `fallbackMs` when the caller sent no usable timeout.
 */
function executionRpcTimeoutMs(
  executionTimeoutMs: unknown,
  fallbackMs: number,
  queueWaitMs = 0,
): number {
  if (
    typeof executionTimeoutMs !== "number" ||
    !Number.isFinite(executionTimeoutMs) ||
    executionTimeoutMs <= 0
  ) {
    return fallbackMs;
  }

  return Math.min(
    MAX_TIMER_DELAY_MS,
    PERMISSION_TIMEOUT_MS +
      queueWaitMs +
      Math.ceil(executionTimeoutMs) +
      COMMAND_RPC_BUFFER_MS,
  );
}
