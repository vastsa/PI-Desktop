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
 * Return the transport deadline for an RPC call. Bash and desktop-dispatched
 * (`plugin_*` / `mcp_*`) tools include the waits host-core can spend before it
 * reports an outcome — the permission gate, the admission queue, and the
 * effective execution timeout — plus transport slack, so the transport never
 * gives up before host-core reports its own timeout. Every call has a finite
 * deadline so a lost response cannot leave a pending promise forever.
 */
export function rpcTimeoutMs(
  method: string,
  params: unknown,
): number {
  if (method !== "tools.execute") return DEFAULT_RPC_TIMEOUT_MS;

  const input = isRecord(params) ? params : undefined;
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
