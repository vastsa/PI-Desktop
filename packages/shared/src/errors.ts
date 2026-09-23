export type AppError = {
  code: string;
  message: string;
  details?: unknown;
  retriable?: boolean;
  causeCode?: string;
  traceId?: string;
};

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err<T = never>(
  code: string,
  message: string,
  extra?: Partial<AppError>,
): Result<T> {
  return {
    ok: false,
    error: { code, message, ...extra },
  };
}

export const ErrorCodes = {
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  HOST_UNAVAILABLE: "HOST_UNAVAILABLE",
  HOST_OVERLOADED: "HOST_OVERLOADED",
  AGENT_UNAVAILABLE: "AGENT_UNAVAILABLE",
  APP_DEGRADED: "APP_DEGRADED",
  INTERNAL: "INTERNAL",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  /** The operation has no implementation on this surface (spec 16 §9). */
  UNSUPPORTED: "UNSUPPORTED",
  CONFLICT: "CONFLICT",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  /**
   * The main-process public-network guard refused a fetch: the URL failed the
   * syntactic public-HTTPS check, or the local DNS lookup returned an address
   * the policy classifies as non-public. Users behind a proxy that answers DNS
   * itself (Clash fake-IP, a TUN resolver, a corporate split resolver) hit this
   * even though the same URL opens in a browser, because the guard resolves
   * locally while `net.fetch` goes through the proxy (ADR 0177, ADR 0243).
   *
   * This is a verdict on an address the resolver produced. A resolver that
   * produces no answer at all is `NETWORK_RESOLVE_FAILED` instead, because
   * reporting it as an address-check refusal names a decision the guard never
   * made (issue #419).
   */
  NETWORK_POLICY_BLOCKED: "NETWORK_POLICY_BLOCKED",
  /**
   * The main-process public-network guard could not classify the target host:
   * the local DNS lookup returned no answer, or threw before returning one. The
   * request is refused exactly as before — this is the absence of a verdict,
   * never permission — but no address was judged, so it must not be reported as
   * an address-check refusal (ADR 0243, issue #419). Retriable: unlike a policy
   * refusal, a resolver or proxy that starts answering the same host makes the
   * same request succeed.
   */
  NETWORK_RESOLVE_FAILED: "NETWORK_RESOLVE_FAILED",
  AGENT_BUSY: "AGENT_BUSY",
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  TURN_NOT_FOUND: "TURN_NOT_FOUND",
  TURN_ABORTED: "TURN_ABORTED",
  MODEL_NOT_CONFIGURED: "MODEL_NOT_CONFIGURED",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  PROVIDER_UNAUTHORIZED: "PROVIDER_UNAUTHORIZED",
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  PROVIDER_SECRET_MISSING: "PROVIDER_SECRET_MISSING",
  MODEL_ALIAS_TOO_LONG: "MODEL_ALIAS_TOO_LONG",
  CONTEXT_TOO_LARGE: "CONTEXT_TOO_LARGE",
  CONTEXT_COMPACTION_FAILED: "CONTEXT_COMPACTION_FAILED",
  STREAM_FAILED: "STREAM_FAILED",
  EMPTY_MODEL_RESPONSE: "EMPTY_MODEL_RESPONSE",
  PROMPT_ENHANCEMENT_EMPTY: "PROMPT_ENHANCEMENT_EMPTY",
  SPEECH_NOT_CONFIGURED: "SPEECH_NOT_CONFIGURED",
  SPEECH_PROTOCOL_UNSUPPORTED: "SPEECH_PROTOCOL_UNSUPPORTED",
  SPEECH_INPUT_TOO_LARGE: "SPEECH_INPUT_TOO_LARGE",
  SUBAGENT_IDLE_TIMEOUT: "SUBAGENT_IDLE_TIMEOUT",
  SUBAGENT_DURATION_TIMEOUT: "SUBAGENT_DURATION_TIMEOUT",
  /**
   * A delegate's own model context exceeded the safe budget: automatic
   * compaction and the degraded retry both failed to bring the subagent's
   * input back under its model's limit. Not retriable — the task itself, the
   * delegate's model, or how much it reads at once has to change.
   */
  SUBAGENT_CONTEXT_OVERFLOW: "SUBAGENT_CONTEXT_OVERFLOW",
  WORKSPACE_REQUIRED: "WORKSPACE_REQUIRED",
  PATH_OUTSIDE_WORKSPACE: "PATH_OUTSIDE_WORKSPACE",
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  TOOL_DENIED: "TOOL_DENIED",
  TOOL_TIMEOUT: "TOOL_TIMEOUT",
  TOOL_FAILED: "TOOL_FAILED",
  /**
   * The mutation recovery guard stopped the turn after repeated same-path Edit
   * or patch-command failures (spec 18-line-anchored-edit-contract §9.3). Retriable: the user may continue.
   */
  MUTATION_RETRY_BUDGET_EXHAUSTED: "MUTATION_RETRY_BUDGET_EXHAUSTED",
  PROCESS_RESOURCE_EXHAUSTED: "PROCESS_RESOURCE_EXHAUSTED",
  TOOL_ABORTED: "TOOL_ABORTED",
  EDIT_TAG_REQUIRED: "EDIT_TAG_REQUIRED",
  EDIT_TAG_MISMATCH: "EDIT_TAG_MISMATCH",
  EDIT_TAG_UNKNOWN: "EDIT_TAG_UNKNOWN",
  EDIT_LINES_UNSEEN: "EDIT_LINES_UNSEEN",
  EDIT_PARSE_FAILED: "EDIT_PARSE_FAILED",
  EDIT_RANGE_INVALID: "EDIT_RANGE_INVALID",
  EDIT_BLOCK_UNRESOLVED: "EDIT_BLOCK_UNRESOLVED",
  EDIT_REGISTER_EMPTY: "EDIT_REGISTER_EMPTY",
  EDIT_REGISTER_AMBIGUOUS: "EDIT_REGISTER_AMBIGUOUS",
  EDIT_REPAIR_AMBIGUOUS: "EDIT_REPAIR_AMBIGUOUS",
  EDIT_NO_CHANGE: "EDIT_NO_CHANGE",
  EDIT_AMPLIFICATION_LIMIT: "EDIT_AMPLIFICATION_LIMIT",
  COMMAND_SHELL_CHANGED: "COMMAND_SHELL_CHANGED",
  SHELL_NOT_FOUND: "SHELL_NOT_FOUND",
  COMMAND_SHELL_INVALID: "COMMAND_SHELL_INVALID",
  PERMISSION_TIMEOUT: "PERMISSION_TIMEOUT",
  PERMISSION_REQUIRED: "PERMISSION_REQUIRED",
  /** A permit or action binding changed, expired, or was already consumed. */
  AUTHORIZATION_STALE: "AUTHORIZATION_STALE",
  /** Human approval must wait until review has returned to the user. */
  REVIEW_IN_PROGRESS: "REVIEW_IN_PROGRESS",
  REVIEW_NOT_AVAILABLE: "REVIEW_NOT_AVAILABLE",
  REVIEW_STALE: "REVIEW_STALE",
  INVALID_REVIEW_DECISION: "INVALID_REVIEW_DECISION",
  TOOL_CONFIG_REQUIRED: "TOOL_CONFIG_REQUIRED",
  BASH_DISABLED_IN_CHAT: "BASH_DISABLED_IN_CHAT",
  WRITE_DISABLED_IN_CHAT: "WRITE_DISABLED_IN_CHAT",
  WRITE_DISABLED_IN_PLAN: "WRITE_DISABLED_IN_PLAN",
  EDIT_DISABLED_IN_PLAN: "EDIT_DISABLED_IN_PLAN",
  PLUGIN_DISABLED_IN_PLAN: "PLUGIN_DISABLED_IN_PLAN",
  TOOL_DISABLED_IN_PLAN: "TOOL_DISABLED_IN_PLAN",
  PLAN_NOT_ACTIVE: "PLAN_NOT_ACTIVE",
  /** SubmitPlan in Goal mode, or SubmitGoal in Plan mode (D198). */
  PLAN_KIND_MISMATCH: "PLAN_KIND_MISMATCH",
  PLAN_REQUIRES_INTERACTIVE_SESSION: "PLAN_REQUIRES_INTERACTIVE_SESSION",
  PLAN_INVALID_ARGUMENT: "PLAN_INVALID_ARGUMENT",
  PLAN_SUBMIT_FAILED: "PLAN_SUBMIT_FAILED",
  PLAN_NOT_FOUND: "PLAN_NOT_FOUND",
  PLAN_ALREADY_PENDING: "PLAN_ALREADY_PENDING",
  PLAN_ALREADY_RESOLVED: "PLAN_ALREADY_RESOLVED",
  PLAN_APPROVAL_REQUIRED: "PLAN_APPROVAL_REQUIRED",
  PLAN_APPROVAL_STALE: "PLAN_APPROVAL_STALE",
  PLAN_APPROVAL_TIMEOUT: "PLAN_APPROVAL_TIMEOUT",
  PLAN_APPROVAL_INTERRUPTED: "PLAN_APPROVAL_INTERRUPTED",
  PLAN_REJECTED: "PLAN_REJECTED",
  PLAN_INVALID_ACTION: "PLAN_INVALID_ACTION",
  PLAN_PERMISSION_MODE_INVALID: "PLAN_PERMISSION_MODE_INVALID",
  PLAN_PERMISSION_MODE_REQUIRED: "PLAN_PERMISSION_MODE_REQUIRED",
  PLAN_APPROVAL_CONFLICT: "PLAN_APPROVAL_CONFLICT",
  PLAN_CONFIGURATION_BLOCKED: "PLAN_CONFIGURATION_BLOCKED",
  PLAN_MARKDOWN_TOO_LARGE: "PLAN_MARKDOWN_TOO_LARGE",
  PLAN_ARTIFACT_INVALID: "PLAN_ARTIFACT_INVALID",
  PLAN_ARTIFACT_PATH_UNSAFE: "PLAN_ARTIFACT_PATH_UNSAFE",
  PLAN_ARTIFACT_WRITE_FAILED: "PLAN_ARTIFACT_WRITE_FAILED",
  PLAN_ARTIFACT_COLLISION_LIMIT: "PLAN_ARTIFACT_COLLISION_LIMIT",
  PLAN_ARTIFACT_NOT_READY: "PLAN_ARTIFACT_NOT_READY",
  PLAN_ARTIFACT_HASH_MISMATCH: "PLAN_ARTIFACT_HASH_MISMATCH",
  PLAN_EXECUTION_ACTIVE: "PLAN_EXECUTION_ACTIVE",
  PLAN_EXECUTION_NOT_FOUND: "PLAN_EXECUTION_NOT_FOUND",
  PLAN_EXECUTION_ALREADY_CLAIMED: "PLAN_EXECUTION_ALREADY_CLAIMED",
  PLAN_EXECUTION_STALE: "PLAN_EXECUTION_STALE",
  PLAN_EXECUTION_STATUS_INVALID: "PLAN_EXECUTION_STATUS_INVALID",
  PLAN_EXECUTION_CONFLICT: "PLAN_EXECUTION_CONFLICT",
  PLAN_EXECUTION_FAILED: "PLAN_EXECUTION_FAILED",
  PLAN_EXECUTION_INTERRUPTED: "PLAN_EXECUTION_INTERRUPTED",
  PLUGIN_INVALID: "PLUGIN_INVALID",
  PLUGIN_LOAD_FAILED: "PLUGIN_LOAD_FAILED",
  /**
   * Remote Agent Control Protocol codes (spec 19-remote-agent-control-protocol
   * §13, D374/D375). They share this registry so a remote error means the
   * same thing as its local counterpart.
   */
  FORBIDDEN: "FORBIDDEN",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  CURSOR_EXPIRED: "CURSOR_EXPIRED",
  CLIENT_TOO_SLOW: "CLIENT_TOO_SLOW",
  APPROVAL_EXPIRED: "APPROVAL_EXPIRED",
  APPROVAL_STALE: "APPROVAL_STALE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  RATE_LIMITED: "RATE_LIMITED",
  /**
   * Remote Host connection codes (D448 / ADR 0284). The desktop adapter and
   * the `pi-host` bootstrap classify a remote failure by these, never by
   * matching message text.
   */
  /** The transport to a paired Host dropped; the Host itself may still be running. */
  HOST_DISCONNECTED: "HOST_DISCONNECTED",
  /** Installing or starting `pi-host` over the bootstrap channel failed. */
  HOST_BOOTSTRAP_FAILED: "HOST_BOOTSTRAP_FAILED",
  /** The paired Host runs a different release than this client. */
  HOST_VERSION_MISMATCH: "HOST_VERSION_MISMATCH",
  /** The device credential was refused by the Host. */
  REMOTE_AUTH_FAILED: "REMOTE_AUTH_FAILED",
  /** The RACP connection could not be established. */
  REMOTE_CONNECTION_FAILED: "REMOTE_CONNECTION_FAILED",
  /** The transport's port forward could not be set up. */
  REMOTE_FORWARD_FAILED: "REMOTE_FORWARD_FAILED",
  /** A Host-side path does not exist. */
  REMOTE_PATH_NOT_FOUND: "REMOTE_PATH_NOT_FOUND",
  /** A Host-side path is outside what the principal may reach. */
  REMOTE_PATH_FORBIDDEN: "REMOTE_PATH_FORBIDDEN",
  PAIRING_FAILED: "PAIRING_FAILED",
  PAIRING_TOKEN_EXPIRED: "PAIRING_TOKEN_EXPIRED",
  /** The Host does not advertise the capability the operation needs. */
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  // Host-core RPC detail codes (spec 06 §7, 08 §3.1/§3.6). Electron surfaces
  // them unchanged through `AppError.code`.
  INVALID_PARAMS: "INVALID_PARAMS",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  HOST_SHUTTING_DOWN: "HOST_SHUTTING_DOWN",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  PLUGIN_NOT_FOUND: "PLUGIN_NOT_FOUND",
  PLUGIN_PERMISSION_DENIED: "PLUGIN_PERMISSION_DENIED",
  PLUGIN_INTEGRITY: "PLUGIN_INTEGRITY",
  PLUGIN_NETWORK: "PLUGIN_NETWORK",
  PLUGIN_HOST_TOO_OLD: "PLUGIN_HOST_TOO_OLD",
  PLUGIN_MARKET_INVALID: "PLUGIN_MARKET_INVALID",
  PLUGIN_MARKET_UNTRUSTED_HOST: "PLUGIN_MARKET_UNTRUSTED_HOST",
  PLUGIN_MARKET_YANKED: "PLUGIN_MARKET_YANKED",
  /** The platform has the version and is not offering it yet. */
  PLUGIN_MARKET_NOT_PUBLISHED: "PLUGIN_MARKET_NOT_PUBLISHED",
  /** The plugin was withdrawn from the platform. */
  PLUGIN_MARKET_ARCHIVED: "PLUGIN_MARKET_ARCHIVED",
  /** The platform does not have that plugin or version. */
  PLUGIN_MARKET_NOT_FOUND: "PLUGIN_MARKET_NOT_FOUND",
  /** The download endpoint asked the client to wait before asking again. */
  PLUGIN_MARKET_RATE_LIMITED: "PLUGIN_MARKET_RATE_LIMITED",
  /** No distribution target can serve the package. */
  PLUGIN_MARKET_NO_SOURCE: "PLUGIN_MARKET_NO_SOURCE",
  /** The user cancelled an install while it was downloading. */
  PLUGIN_CANCELLED: "PLUGIN_CANCELLED",
  MCP_INVALID: "MCP_INVALID",
  SKILL_INVALID: "SKILL_INVALID",
  SUBAGENT_INVALID: "SUBAGENT_INVALID",
  CAPABILITY_INVALID: "CAPABILITY_INVALID",
  // Native tool detail codes (spec 08 §3.3).
  WORKSPACE_PATH_DENIED: "WORKSPACE_PATH_DENIED",
  READ_PATH_IS_DIRECTORY: "READ_PATH_IS_DIRECTORY",
  TOOL_BINARY_CONTENT: "TOOL_BINARY_CONTENT",
  // Plan/Goal host-side codes that reach the sidecar as `errorCode`.
  PLAN_SESSION_NOT_FOUND: "PLAN_SESSION_NOT_FOUND",
  PLAN_WORKSPACE_REQUIRED: "PLAN_WORKSPACE_REQUIRED",
  PLAN_ALREADY_ACTIVE: "PLAN_ALREADY_ACTIVE",
  PLAN_INTERNAL: "PLAN_INTERNAL",
} as const;
