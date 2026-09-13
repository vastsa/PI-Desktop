import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A small JSON Schema subset used by MCP's tools/list response. */
export type McpJsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: McpJsonSchema;
  enum?: string[];
};

export type McpControlRisk = "read" | "write" | "dangerous";

export type McpControlOperation = {
  id: string;
  channel: string;
  description: string;
  risk: McpControlRisk;
  argumentShape: string[] | string;
};

export type McpControlInvokeInput = {
  operation: string;
  args?: readonly unknown[];
  confirm?: boolean;
  /** Internal origin used to keep plugin background work from stealing focus. */
  source?: "mcp" | "plugin";
};

export type McpControlInvocationSource = NonNullable<McpControlInvokeInput["source"]>;

export type McpControlController = {
  operations: readonly McpControlOperation[];
  invoke: (input: McpControlInvokeInput) => Promise<unknown>;
};

export type McpControlConnectionInfo = {
  active: boolean;
  serverName: string;
  protocol: "streamable-http";
  url: string;
  token: string;
  pid: number;
  startedAt?: string;
};

export type McpControlRendererEvent = {
  reason: string;
  projectPath?: string | null;
  selectSessionId?: string;
};

type IpcInvoke = (channel: string, args: readonly unknown[]) => Promise<unknown>;
type OperationSpec = {
  channelKey: string;
  id: string;
  description: string;
  risk: McpControlRisk;
  argumentShape: string[] | string;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
  execute: (input: unknown) => Promise<unknown>;
};

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type DispatchResult = {
  response: JsonRpcResponse;
  sessionId?: string;
};

type Logger = (level: "info" | "warn" | "error", message: string, data?: unknown) => void;

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_COMPATIBLE_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26"]);
const MCP_SERVER_NAME = "pi-desktop";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 37_123;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_CHARS = 512 * 1024;
const MAX_ARGUMENT_ITEMS = 32;
const MAX_MCP_SESSIONS = 32;
const SHUTDOWN_CLOSE_MS = 1_000;
const GENERIC_ARGUMENT_SHAPE =
  "renderer IPC arguments; use the corresponding pi_* tool when available";

const SECRET_FIELD_NAMES = new Set([
  "secretvalue",
  "secret_value",
  "apikey",
  "api_key",
  "clientsecret",
  "client_secret",
  "accesstoken",
  "refreshtoken",
  "password",
  "passwd",
]);

const SECRET_HEADER_NAMES = new Set(["authorization", "x-api-key", "api-key"]);
const SECRET_ENV_NAME = /(?:secret|token|password|passwd|api[_-]?key)/i;

const SESSION_MUTATION_IDS = new Set([
  "session/create",
  "session/fork",
  "session/delete",
  "session/rename",
  "session/configure",
  "session/moveProject",
  "session/summarizeTitle",
  "session/replaceMessages",
  "session/saveRevision",
  "session/activateRevision",
  "session/importRun",
]);

const objectSchema = (
  properties: Record<string, McpJsonSchema>,
  required: string[] = [],
): McpJsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const anySchema = (): McpJsonSchema => ({
  additionalProperties: true,
});

const stringSchema = (description?: string): McpJsonSchema => ({
  type: "string",
  ...(description ? { description } : {}),
});

const booleanSchema = (description?: string): McpJsonSchema => ({
  type: "boolean",
  ...(description ? { description } : {}),
});

const spec = (
  channelKey: string,
  id: string,
  description: string,
  risk: McpControlRisk = "write",
  argumentShape: string[] | string = GENERIC_ARGUMENT_SHAPE,
): OperationSpec => ({ channelKey, id, description, risk, argumentShape });

/**
 * IPC operations exposed through the local control plane.
 *
 * First-version surface is the project/session/Agent/workspace flow plus
 * reviewed reads. Secret writes, native pickers, plugin/marketplace install,
 * window/OS control, and provider/OAuth credential mutations stay out.
 * A future IPC channel is not automatically exposed until reviewed here.
 */
const CONTROL_OPERATION_SPECS: OperationSpec[] = [
  spec("appGetVersion", "app/getVersion", "Return PI-Desktop and host versions.", "read", []),
  spec("appHealth", "app/health", "Return host health.", "read", []),
  spec("appGetOnboarding", "app/getOnboarding", "Read onboarding state.", "read", []),
  spec("appDismissOnboarding", "app/dismissOnboarding", "Dismiss onboarding.", "write", []),
  spec("systemFontsList", "app/systemFonts", "List installed system fonts.", "read", []),
  spec("updatesGetState", "updates/getState", "Read application update state.", "read", []),
  spec("updatesCheck", "updates/check", "Check for application updates.", "write", []),
  spec("notificationList", "notification/list", "List durable notifications.", "read", []),
  spec("notificationMarkRead", "notification/markRead", "Mark one notification as read.", "write", ["id"]),
  spec("notificationMarkAllRead", "notification/markAllRead", "Mark all notifications as read.", "write", []),
  spec("agentInstructionsGet", "agent/instructions/get", "Read global or project AGENTS.md instructions.", "read", ["query"]),
  spec("agentInstructionsSave", "agent/instructions/save", "Write global or project AGENTS.md instructions.", "dangerous", ["input"]),
  spec("agentPrompt", "agent/prompt", "Send a prompt to a session's Agent.", "write", ["request"]),
  spec("promptEnhance", "prompt/enhance", "Enhance a prompt using the configured model.", "write", ["request"]),
  spec("agentCompact", "agent/compact", "Compact an idle session context.", "write", ["request"]),
  spec("agentAbort", "agent/abort", "Abort an active Agent turn.", "write", ["request"]),
  spec("agentStop", "agent/stop", "Request a graceful Agent stop.", "write", ["request"]),
  spec("agentGetStatus", "agent/getStatus", "Read Agent runtime status.", "read", ["sessionId"]),
  spec("sessionList", "session/list", "List durable sessions.", "read", []),
  spec("sessionCreate", "session/create", "Create a durable session.", "write", ["input"]),
  spec("sessionFork", "session/fork", "Fork a session.", "write", ["input"]),
  spec("sessionGet", "session/get", "Read a session and its transcript.", "read", ["input"]),
  spec("sessionOpen", "session/open", "Open a durable session in the desktop.", "write", ["sessionId"]),
  spec("sessionDelete", "session/delete", "Delete a session.", "dangerous", ["id"]),
  spec("sessionRename", "session/rename", "Rename a session.", "write", ["id", "title"]),
  spec("sessionConfigure", "session/configure", "Configure a session for its next turn, including permission mode.", "dangerous", ["id", "config"]),
  spec("sessionMoveProject", "session/moveProject", "Move an idle session to another project.", "write", ["input"]),
  spec("sessionListRevisions", "session/listRevisions", "List transcript revisions.", "read", ["input"]),
  spec("sessionGetScratchPath", "session/getScratchPath", "Return a session scratch path.", "read", ["input"]),
  spec("sessionImportScan", "session/importScan", "Scan supported external session sources.", "read", []),
  spec("modelConfigImportScan", "modelConfig/importScan", "Scan supported model configuration sources.", "read", []),
  spec("sessionSummarizeTitle", "session/summarizeTitle", "Generate a session title.", "write", ["request"]),
  spec("settingsGet", "settings/get", "Read application settings.", "read", []),
  spec("networkProxyTest", "network/testProxy", "Test a network proxy configuration.", "read", ["settings"]),
  spec("commandShellList", "commandShell/list", "List supported command shells.", "read", []),
  spec("providersList", "providers/list", "List configured providers without plaintext secrets.", "read", []),
  spec("providersListModels", "providers/listModels", "List cached provider models.", "read", ["input"]),
  spec("providersRefreshModelCatalog", "providers/refreshModelCatalog", "Refresh the models.dev catalog.", "write", []),
  spec("providersModelCatalogStatus", "providers/modelCatalogStatus", "Read model catalog status.", "read", []),
  spec("providersOauthVendors", "providers/oauth/vendors", "List OAuth vendors and local accounts.", "read", []),
  spec("projectGet", "project/get", "Read the active project workspace.", "read", []),
  spec("projectList", "project/list", "List durable projects.", "read", []),
  spec("projectSet", "project/set", "Open and bind a project path.", "write", ["path"]),
  spec("projectClear", "project/clear", "Clear the active project.", "write", []),
  spec("workspaceDiff", "workspace/diff", "Read the active workspace diff.", "read", []),
  spec("statsGetTokenUsageHistory", "stats/getTokenUsageHistory", "Read completed-turn token usage history.", "read", ["input"]),
  spec("browserGetState", "browser/getState", "Read embedded Browser state.", "read", []),
  spec("fsList", "fs/list", "List files in the active workspace.", "read", ["input"]),
  spec("fsRead", "fs/read", "Read an allowed workspace or session file.", "read", ["input"]),
  spec("fsReadImageDataUrl", "fs/readImageDataUrl", "Read an allowed image as a data URL.", "read", ["input"]),
  spec("fsIndex", "fs/index", "Index files in the active workspace.", "read", ["input"]),
  spec("composerCommands", "composer/commands", "List composer commands and skills.", "read", []),
  spec("closeBehaviorGet", "window/closeBehavior/get", "Read close behavior.", "read", []),
  spec("pullsList", "pulls/list", "List pull requests for the active workspace.", "read", []),
  spec("scheduledList", "scheduled/list", "List scheduled tasks.", "read", []),
  spec("toolResolvePermission", "tool/resolvePermission", "Resolve a pending tool permission request.", "dangerous", ["resolution"]),
  spec("askToolResolve", "agent/askTool/resolve", "Answer an Agent question.", "dangerous", ["resolution"]),
  spec("plansPending", "plans/pending", "List pending Plan or Goal approvals.", "read", ["input"]),
  spec("plansResolve", "plans/resolve", "Approve or reject a Plan or Goal checkpoint.", "dangerous", ["resolution"]),
  spec("pluginList", "plugin/list", "List installed plugins.", "read", []),
  spec("pluginSettingsGet", "plugin/settings/get", "Read plugin setting definitions.", "read", ["input"]),
  spec("pluginViews", "plugin/views", "List plugin-contributed views.", "read", []),
  spec("pluginThemes", "plugin/themes", "List plugin themes.", "read", []),
  spec("pluginServices", "plugin/services", "List plugin service states.", "read", []),
  spec("mcpList", "mcp/list", "List user-owned MCP servers.", "read", ["query"]),
  spec("skillList", "skill/list", "List user-owned Skills.", "read", ["query"]),
  spec("skillRead", "skill/read", "Read a user-owned Skill.", "read", ["input"]),
  spec("subagentList", "subagent/list", "List user-owned Subagents.", "read", ["query"]),
  spec("subagentCatalog", "subagent/catalog", "Read the effective Subagent catalog.", "read", ["query"]),
  spec("subagentRead", "subagent/read", "Read a user-owned Subagent.", "read", ["input"]),
  spec("marketSearch", "market/search", "Search the plugin marketplace.", "read", ["query"]),
  spec("marketGetDetail", "market/getDetail", "Read marketplace plugin details.", "read", ["input"]),
  spec("commandPaletteSearch", "commandPalette/search", "Search command-palette commands.", "read", ["query"]),
  // Trusted extensions (spec 16 §10.2): reads and session-scoped command runs
  // are exposed; enablement, paths, and removal stay local (blocked below).
  spec("extensionsCommandRun", "extensions/commands/run", "Run a trusted extension command in a session.", "write", ["input"]),
  spec("extensionsUiRespond", "extensions/ui/respond", "Answer a pending trusted extension prompt.", "dangerous", ["response"]),
];

const coreTool = (
  name: string,
  description: string,
  inputSchema: McpJsonSchema,
  operationId: string,
  toArgs: (input: Record<string, unknown>) => readonly unknown[],
): {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
  operationId: string;
  toArgs: (input: Record<string, unknown>) => readonly unknown[];
} => ({
  name,
  description,
  inputSchema,
  operationId,
  toArgs,
});

const CORE_TOOL_SPECS = [
  coreTool("pi_app_info", "Read PI-Desktop and host version information.", objectSchema({}), "app/getVersion", () => []),
  coreTool("pi_project_get", "Read the active project workspace.", objectSchema({}), "project/get", () => []),
  coreTool("pi_project_list", "List durable projects.", objectSchema({}), "project/list", () => []),
  coreTool(
    "pi_project_open",
    "Open and bind a project directory by absolute or user-resolvable path.",
    objectSchema({ path: stringSchema("Project directory path.") }, ["path"]),
    "project/set",
    (input) => [input.path],
  ),
  coreTool("pi_project_clear", "Clear the active project workspace.", objectSchema({}), "project/clear", () => []),
  coreTool("pi_session_list", "List durable sessions.", objectSchema({}), "session/list", () => []),
  coreTool(
    "pi_session_create",
    "Create a durable session, optionally bound to a project and model.",
    objectSchema({
      title: stringSchema(),
      projectPath: stringSchema(),
      mode: { type: "string", enum: ["agent", "plan", "goal"] },
      providerId: stringSchema(),
      modelId: stringSchema(),
      thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    }),
    "session/create",
    (input) => [stripSecretMaterial(input)],
  ),
  coreTool(
    "pi_session_get",
    "Read a session and a bounded transcript page.",
    objectSchema({
      id: stringSchema("Session id."),
      messageBefore: { type: "integer" },
      messageLimit: { type: "integer" },
      contentLimit: { type: "integer" },
    }, ["id"]),
    "session/get",
    (input) => [input],
  ),
  coreTool(
    "pi_session_rename",
    "Rename a session.",
    objectSchema({ id: stringSchema("Session id."), title: stringSchema("New title.") }, ["id", "title"]),
    "session/rename",
    (input) => [input.id, input.title],
  ),
  coreTool(
    "pi_session_fork",
    "Fork a session, optionally at a transcript message.",
    objectSchema({ id: stringSchema("Source session id."), title: stringSchema(), throughMessageId: stringSchema() }, ["id"]),
    "session/fork",
    (input) => [{ sessionId: input.id, title: input.title, throughMessageId: input.throughMessageId }],
  ),
  coreTool(
    "pi_session_delete",
    "Delete a session. Set confirm=true to acknowledge the destructive action.",
    objectSchema({ id: stringSchema("Session id."), confirm: booleanSchema("Required acknowledgement.") }, ["id", "confirm"]),
    "session/delete",
    (input) => [input.id],
  ),
  coreTool(
    "pi_session_configure",
    "Configure a session for its next turn, including permission mode. Set confirm=true; this can enable Auto tool approval.",
    objectSchema({
      id: stringSchema("Session id."),
      mode: { type: "string", enum: ["agent", "plan", "goal"] },
      providerId: stringSchema(),
      modelId: stringSchema(),
      thinkingLevel: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      permissionMode: { type: "string", enum: ["inherit", "ask", "accept-edits", "auto"] },
      confirm: booleanSchema("Required acknowledgement, including permission-mode changes."),
    }, ["id", "mode", "confirm"]),
    "session/configure",
    (input) => {
      const { id, confirm: _confirm, ...config } = input;
      return [id, config];
    },
  ),
  coreTool(
    "pi_agent_prompt",
    "Send a prompt to a session's Agent. Returns when the turn is accepted, not when it finishes.",
    objectSchema({
      sessionId: stringSchema("Target session id."),
      content: stringSchema("Prompt text."),
      viewingSessionId: stringSchema(),
      attachments: { type: "array", items: anySchema() },
    }, ["sessionId", "content"]),
    "agent/prompt",
    (input) => [stripSecretMaterial(input)],
  ),
  coreTool(
    "pi_agent_status",
    "Read a session's Agent runtime status.",
    objectSchema({ sessionId: stringSchema("Target session id.") }, ["sessionId"]),
    "agent/getStatus",
    (input) => [input.sessionId],
  ),
  coreTool(
    "pi_agent_stop",
    "Request a graceful stop at the next Agent turn boundary.",
    objectSchema({ sessionId: stringSchema("Target session id.") }, ["sessionId"]),
    "agent/stop",
    (input) => [input],
  ),
  coreTool(
    "pi_agent_abort",
    "Abort the active Agent turn.",
    objectSchema({ sessionId: stringSchema("Target session id.") }, ["sessionId"]),
    "agent/abort",
    (input) => [input],
  ),
  coreTool(
    "pi_agent_compact",
    "Compact an idle session context.",
    objectSchema({ sessionId: stringSchema("Target session id.") }, ["sessionId"]),
    "agent/compact",
    (input) => [input],
  ),
  coreTool(
    "pi_plans_pending",
    "List pending Plan or Goal approvals.",
    objectSchema({ sessionId: stringSchema() }),
    "plans/pending",
    (input) => [input],
  ),
  coreTool(
    "pi_plans_resolve",
    "Approve or reject a Plan or Goal checkpoint.",
    objectSchema({
      proposalId: stringSchema("Proposal id."),
      sessionId: stringSchema("Session id."),
      turnId: stringSchema("Turn id."),
      toolCallId: stringSchema("Plan tool-call id."),
      action: { type: "string", enum: ["approve", "reject"] },
      version: { type: "integer" },
      targetPermissionMode: { type: "string", enum: ["ask", "accept-edits", "auto"] },
      confirm: booleanSchema("Required acknowledgement for approval or rejection."),
    }, ["proposalId", "sessionId", "turnId", "toolCallId", "action", "confirm"]),
    "plans/resolve",
    (input) => {
      const { confirm: _confirm, ...resolution } = input;
      return [resolution];
    },
  ),
  coreTool("pi_workspace_diff", "Read the active workspace diff.", objectSchema({}), "workspace/diff", () => []),
  coreTool(
    "pi_fs_list",
    "List files in the active workspace.",
    objectSchema({ path: stringSchema("Workspace-relative path.") }),
    "fs/list",
    (input) => [input],
  ),
  coreTool(
    "pi_fs_read",
    "Read an allowed workspace or session file.",
    objectSchema({ path: stringSchema("Workspace-relative path or allowed attachment ref."), mimeType: stringSchema() }, ["path"]),
    "fs/read",
    (input) => [input],
  ),
] as const;

export const MCP_CONTROL_CATALOG_CHANNEL_KEYS = CONTROL_OPERATION_SPECS.map((entry) => entry.channelKey);

export const MCP_CONTROL_BLOCKED_CHANNEL_KEYS = [
  "secretsSet",
  "secretsDelete",
  "secretsHas",
  "projectOpen",
  "pluginLoadDev",
  "pluginCreateFromTemplate",
  "pluginInstallFromPath",
  "pluginInstallFromPackage",
  "pluginLauncherDismiss",
  "skillImport",
  "composerPickFiles",
  "composerPickPhotos",
  "composerImportFiles",
  "composerPasteFiles",
  "clipboardRecordPaste",
  "menuRendererReady",
  "providersCreate",
  "providersUpdate",
  "providersDelete",
  "providersTest",
  "providersOauthStart",
  "providersOauthRespond",
  "providersOauthCancel",
  "providersOauthDelete",
  "settingsSet",
  "mcpUpsert",
  "mcpImport",
  // Importing a pi extension opens a native picker and grants agent.extension.
  "pluginImportExtension",
] as const;

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("tool arguments must be an object"), { code: "INVALID_PARAMS" });
  }
  return value as Record<string, unknown>;
}

function assertRequiredFields(schema: McpJsonSchema, input: Record<string, unknown>, toolName: string): void {
  for (const key of schema.required ?? []) {
    if (input[key] === undefined) {
      throw Object.assign(new Error(`${toolName} requires ${key}`), { code: "INVALID_PARAMS" });
    }
  }
}

export function stripSecretMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripSecretMaterial(entry));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replaceAll("-", "_").toLowerCase();
    if (SECRET_FIELD_NAMES.has(normalized)) continue;
    if (key === "headers" && nested && typeof nested === "object" && !Array.isArray(nested)) {
      const headers: Record<string, unknown> = {};
      for (const [headerName, headerValue] of Object.entries(nested as Record<string, unknown>)) {
        if (SECRET_HEADER_NAMES.has(headerName.toLowerCase())) continue;
        headers[headerName] = headerValue;
      }
      output[key] = headers;
      continue;
    }
    if (key === "env" && nested && typeof nested === "object" && !Array.isArray(nested)) {
      const env: Record<string, unknown> = {};
      for (const [envName, envValue] of Object.entries(nested as Record<string, unknown>)) {
        if (SECRET_ENV_NAME.test(envName)) continue;
        env[envName] = envValue;
      }
      output[key] = env;
      continue;
    }
    output[key] = stripSecretMaterial(nested);
  }
  return output;
}

export function boundMcpResult(value: unknown): unknown {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    text = JSON.stringify({ value: String(value) });
  }
  if (text.length <= MAX_RESULT_CHARS) {
    try {
      return value ?? null;
    } catch {
      return { value: String(value) };
    }
  }
  return {
    truncated: true,
    reason: "MCP_RESULT_LIMIT",
    preview: text.slice(0, MAX_RESULT_CHARS),
  };
}

function errorInfo(error: unknown): { code: string; message: string; details?: unknown } {
  const candidate = error as {
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
    data?: { errorCode?: unknown; details?: unknown };
  } | null;
  const code = String(candidate?.data?.errorCode ?? candidate?.errorCode ?? candidate?.code ?? "INTERNAL");
  const message = String(candidate?.message ?? error ?? "operation failed");
  const details = candidate?.data?.details;
  return details === undefined ? { code, message } : { code, message, details };
}

function response(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "::1") return true;
  if (isIP(normalized) === 4) {
    const octets = normalized.split(".").map((part) => Number(part));
    return octets[0] === 127;
  }
  return false;
}

export function negotiateMcpProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && MCP_COMPATIBLE_PROTOCOL_VERSIONS.has(requested.trim())) {
    return requested.trim();
  }
  return MCP_PROTOCOL_VERSION;
}

export function tokensEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function createMcpControlOperations(
  channels: Readonly<Record<string, string>>,
): McpControlOperation[] {
  return CONTROL_OPERATION_SPECS.flatMap((entry) => {
    const channel = channels[entry.channelKey];
    if (!channel) return [];
    return [{
      id: entry.id,
      channel,
      description: entry.description,
      risk: entry.risk,
      argumentShape: entry.argumentShape,
    }];
  });
}

export function mcpControlRendererEvent(
  operation: McpControlOperation,
  result: unknown,
  args: readonly unknown[],
  source?: McpControlInvocationSource,
): McpControlRendererEvent | null {
  const payload = result as {
    session?: { id?: string; projectPath?: string | null } | null;
    workspace?: { path?: string | null } | null;
  } | null;
  const sessionId = payload?.session?.id?.trim();
  if (operation.id === "session/create" || operation.id === "session/fork") {
    if (!sessionId) return null;
    if (source === "plugin") return { reason: "plugin.session" };
    return {
      reason: "mcp.session",
      selectSessionId: sessionId,
      projectPath: payload?.session?.projectPath ?? null,
    };
  }
  if (operation.id === "session/open") {
    if (!sessionId) return null;
    return {
      reason: source === "plugin" ? "plugin.session.open" : "mcp.session.open",
      selectSessionId: sessionId,
      projectPath: payload?.session?.projectPath ?? null,
    };
  }
  const promptedSessionId =
    operation.id === "agent/prompt" &&
    args[0] &&
    typeof args[0] === "object" &&
    typeof (args[0] as { sessionId?: unknown }).sessionId === "string"
      ? (args[0] as { sessionId: string }).sessionId.trim()
      : "";
  if (operation.id === "agent/prompt" && promptedSessionId) {
    if (source === "plugin") return { reason: "plugin.prompt" };
    return { reason: "mcp.prompt", selectSessionId: promptedSessionId };
  }
  if (operation.id === "project/set") {
    return { reason: "mcp.project", projectPath: payload?.workspace?.path ?? null };
  }
  if (operation.id === "project/clear") {
    return { reason: "mcp.project", projectPath: null };
  }
  if (SESSION_MUTATION_IDS.has(operation.id) || operation.id === "plans/resolve") {
    return { reason: "mcp.session" };
  }
  return null;
}

/**
 * Shared invocation gateway for MCP and first-party plugins.
 *
 * Keeping validation and confirmation in one controller prevents another host
 * surface from silently drifting away from the reviewed MCP operation set.
 */
export function createMcpControlController(options: {
  channels: Readonly<Record<string, string>>;
  invoke: IpcInvoke;
  onOperationComplete?: (
    operation: McpControlOperation,
    result: unknown,
    args: readonly unknown[],
    source?: McpControlInvocationSource,
  ) => void | Promise<void>;
}): McpControlController {
  const operations = createMcpControlOperations(options.channels);
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));
  return {
    operations,
    invoke: async (input) => {
      if (!input || typeof input.operation !== "string" || !input.operation.trim()) {
        throw Object.assign(new Error("operation is required"), { code: "INVALID_PARAMS" });
      }
      const operation = operationById.get(input.operation);
      if (!operation) {
        throw Object.assign(new Error(`operation is not exposed: ${input.operation}`), {
          code: "NOT_FOUND",
        });
      }
      const args = input.args === undefined ? [] : input.args;
      if (!Array.isArray(args)) {
        throw Object.assign(new Error("args must be an array"), { code: "INVALID_PARAMS" });
      }
      if (args.length > MAX_ARGUMENT_ITEMS) {
        throw Object.assign(new Error("too many IPC arguments"), { code: "INVALID_PARAMS" });
      }
      if (operation.risk === "dangerous" && input.confirm !== true) {
        throw Object.assign(new Error(`confirm=true is required for ${operation.id}`), {
          code: "CONFIRMATION_REQUIRED",
        });
      }
      const sanitized = args.map((value) => stripSecretMaterial(value)) as unknown[];
      const result = await options.invoke(operation.channel, sanitized);
      await options.onOperationComplete?.(operation, result, sanitized, input.source);
      return result;
    },
  };
}

export type McpControlServerOptions = {
  dataDir: string;
  invoke: IpcInvoke;
  channels: Readonly<Record<string, string>>;
  controller?: McpControlController;
  host?: string;
  port?: number;
  version?: string;
  onOperationComplete?: (
    operation: McpControlOperation,
    result: unknown,
    args: readonly unknown[],
  ) => void | Promise<void>;
  log?: Logger;
};

/**
 * Local Streamable HTTP MCP server for controlling the running desktop.
 *
 * This server intentionally owns no product logic. Every operation delegates
 * to the same Electron-main IPC handler used by the renderer, which keeps the
 * external-agent surface aligned with the desktop's permission and lifecycle
 * checks.
 */
export class McpControlServer {
  private readonly dataDir: string;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly version: string;
  private readonly log: Logger;
  private readonly controller: McpControlController;
  private readonly operations: McpControlOperation[];
  private readonly operationById = new Map<string, McpControlOperation>();
  private readonly toolsList: McpTool[];
  private readonly sessions = new Set<string>();
  private readonly serverName = MCP_SERVER_NAME;
  private server: ReturnType<typeof createServer> | null = null;
  private token = "";
  private port: number | null = null;
  private startedAt: string | undefined;

  constructor(options: McpControlServerOptions) {
    this.dataDir = options.dataDir;
    this.host = options.host ?? DEFAULT_HOST;
    this.requestedPort = options.port ?? DEFAULT_PORT;
    this.version = options.version ?? "1";
    this.log = options.log ?? (() => undefined);
    this.controller = options.controller ?? createMcpControlController({
      channels: options.channels,
      invoke: options.invoke,
      onOperationComplete: options.onOperationComplete,
    });
    this.operations = [...this.controller.operations];
    for (const operation of this.operations) this.operationById.set(operation.id, operation);
    this.toolsList = this.buildTools();
  }

  get isRunning(): boolean {
    return this.server !== null && this.port !== null;
  }

  get connectionInfo(): McpControlConnectionInfo | null {
    if (!this.port || !this.token) return null;
    const hostname = this.host.includes(":") && !this.host.startsWith("[") ? `[${this.host}]` : this.host;
    return {
      active: this.isRunning,
      serverName: this.serverName,
      protocol: "streamable-http",
      url: `http://${hostname}:${this.port}/mcp`,
      token: this.token,
      pid: process.pid,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
    };
  }

  async start(): Promise<McpControlConnectionInfo | null> {
    if (this.server) return this.connectionInfo;
    if (!isLoopbackBindHost(this.host)) {
      throw new Error("MCP control server must bind a loopback address");
    }
    if (!Number.isInteger(this.requestedPort) || this.requestedPort < 0 || this.requestedPort > 65_535) {
      throw new Error("invalid MCP control port");
    }
    await mkdir(this.dataDir, { recursive: true });
    this.token = await this.loadToken();
    const server = createServer((request, result) => {
      void this.handleRequest(request, result);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.requestedPort, this.host);
      });
    } catch (error) {
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      await this.stop();
      throw new Error("MCP control server did not expose a TCP address");
    }
    if (!isLoopbackBindHost(address.address)) {
      await this.stop();
      throw new Error("MCP control server bound a non-loopback address");
    }
    this.port = address.port;
    this.startedAt = new Date().toISOString();
    const info = this.connectionInfo;
    if (!info) {
      await this.stop();
      throw new Error("MCP control connection info unavailable");
    }
    try {
      await this.writeConnectionInfo(info);
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
    this.log("info", "MCP control server listening", {
      url: info.url,
      port: this.port,
      operationCount: this.operations.length,
    });
    return info;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.sessions.clear();
    if (server) {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_CLOSE_MS);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const info = this.connectionInfo;
    if (info) await this.writeConnectionInfo({ ...info, active: false });
    this.port = null;
  }

  private async loadToken(): Promise<string> {
    const path = join(this.dataDir, "mcp-control.token");
    try {
      const existing = (await readFile(path, "utf8")).trim();
      if (/^[a-f0-9]{64}$/i.test(existing)) {
        await chmod(path, 0o600).catch(() => undefined);
        return existing;
      }
    } catch {
      // Generate the first token below.
    }
    const token = randomBytes(32).toString("hex");
    await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(path, 0o600);
    } catch {
      // Windows does not expose POSIX mode bits.
    }
    return token;
  }

  private async writeConnectionInfo(info: McpControlConnectionInfo): Promise<void> {
    const path = join(this.dataDir, "mcp-control.json");
    await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await chmod(path, 0o600);
    } catch {
      // Windows does not expose POSIX mode bits.
    }
  }

  private headerValue(request: IncomingMessage, name: string): string | null {
    const value = request.headers[name];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const authorization = this.headerValue(request, "authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : this.headerValue(request, "x-pi-desktop-token");
    return typeof token === "string" && token.length > 0 && tokensEqual(token, this.token);
  }

  private isAllowedOrigin(request: IncomingMessage): boolean {
    const rawOrigin = request.headers.origin;
    if (!rawOrigin) return true;
    if (Array.isArray(rawOrigin)) return false;
    try {
      const origin = new URL(rawOrigin);
      if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
      return origin.hostname === "localhost" ||
        origin.hostname === "127.0.0.1" ||
        origin.hostname === "[::1]" ||
        origin.hostname === "::1";
    } catch {
      return false;
    }
  }

  private isAllowedHostHeader(request: IncomingMessage): boolean {
    const raw = this.headerValue(request, "host");
    if (!raw) return true;
    const hostname = raw.startsWith("[")
      ? raw.slice(1, raw.indexOf("]"))
      : raw.split(":")[0] ?? "";
    return hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === this.host;
  }

  private protocolVersion(request: IncomingMessage): string | null {
    return this.headerValue(request, "mcp-protocol-version");
  }

  private async handleRequest(request: IncomingMessage, result: ServerResponse): Promise<void> {
    result.setHeader("Cache-Control", "no-store");
    result.setHeader("X-Content-Type-Options", "nosniff");
    if (!this.isAllowedOrigin(request) || !this.isAllowedHostHeader(request)) {
      this.sendHttp(result, 403, { error: "origin not allowed" });
      return;
    }
    if (request.method === "OPTIONS") {
      result.writeHead(204, {
        Allow: "POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, X-Pi-Desktop-Token",
        "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
      });
      result.end();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== "/mcp" && pathname !== "/mcp/") {
      this.sendHttp(result, 404, { error: "not found" });
      return;
    }
    if (!this.isAuthorized(request)) {
      this.sendHttp(result, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }
    if (request.method === "DELETE") {
      const sessionId = this.sessionId(request);
      if (!sessionId || !this.sessions.has(sessionId)) {
        this.sendHttp(result, 404, { error: "unknown MCP session" });
        return;
      }
      this.sessions.delete(sessionId);
      result.writeHead(204);
      result.end();
      return;
    }
    if (request.method === "GET") {
      this.sendHttp(result, 405, { error: "SSE stream not supported" }, { Allow: "POST, DELETE, OPTIONS" });
      return;
    }
    if (request.method !== "POST") {
      this.sendHttp(result, 405, { error: "method not allowed" }, { Allow: "POST, DELETE, OPTIONS" });
      return;
    }
    let body: unknown;
    try {
      body = await this.readJson(request);
    } catch (error) {
      this.sendJsonRpc(result, rpcError(null, -32700, error instanceof Error ? error.message : "invalid JSON"));
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      this.sendJsonRpc(result, rpcError(null, -32600, "JSON-RPC request must be an object"));
      return;
    }
    const requestBody = body as JsonRpcRequest;
    if (requestBody.jsonrpc !== undefined && requestBody.jsonrpc !== "2.0") {
      this.sendJsonRpc(result, rpcError(requestBody.id ?? null, -32600, "jsonrpc must be \"2.0\""));
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(requestBody, "id");
    const id = hasId ? requestBody.id ?? null : null;
    const method = typeof requestBody.method === "string" ? requestBody.method : "";
    const sessionId = this.sessionId(request);
    const protocolVersion = this.protocolVersion(request);
    if (protocolVersion && !MCP_COMPATIBLE_PROTOCOL_VERSIONS.has(protocolVersion)) {
      this.sendHttp(result, 400, { error: "unsupported MCP protocol version" });
      return;
    }
    if (method !== "initialize" && !sessionId) {
      this.sendHttp(result, 400, { error: "Mcp-Session-Id is required" });
      return;
    }
    if (method !== "initialize" && sessionId && !this.sessions.has(sessionId)) {
      this.sendHttp(result, 404, { error: "unknown MCP session" });
      return;
    }
    if (!hasId && method.startsWith("notifications/")) {
      if (method === "notifications/initialized") {
        result.writeHead(202);
        result.end();
        return;
      }
      result.writeHead(202);
      result.end();
      return;
    }
    if (!hasId) {
      this.sendHttp(result, 400, { error: "JSON-RPC id is required" });
      return;
    }
    try {
      const dispatched = await this.dispatch(requestBody);
      if (dispatched === null) {
        result.writeHead(202);
        result.end();
        return;
      }
      this.sendJsonRpc(
        result,
        dispatched.response,
        dispatched.sessionId ? { "Mcp-Session-Id": dispatched.sessionId } : undefined,
      );
    } catch (error) {
      this.sendJsonRpc(result, rpcError(id, -32603, "internal error", errorInfo(error)));
    }
  }

  private async dispatch(request: JsonRpcRequest): Promise<DispatchResult | null> {
    const id = request.id ?? null;
    const method = typeof request.method === "string" ? request.method : "";
    const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    if (method === "initialize") {
      const sessionId = randomUUID();
      if (this.sessions.size >= MAX_MCP_SESSIONS) {
        const oldest = this.sessions.values().next().value;
        if (oldest) this.sessions.delete(oldest);
      }
      this.sessions.add(sessionId);
      return {
        response: response(id, {
          protocolVersion: negotiateMcpProtocolVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.serverName, version: this.version },
          instructions:
            "Local PI-Desktop control plane. Named tools cover project/session/Agent/workspace. Dangerous operations, including session/configure permissionMode, require confirm=true. confirm is an agent acknowledgement, not a desktop user prompt. Poll pi_session_get or pi_agent_status for turn progress; this server does not stream SSE.",
        }),
        sessionId,
      };
    }
    if (method === "notifications/initialized") return null;
    if (method === "ping") return { response: response(id, {}) };
    if (method === "tools/list") {
      return { response: response(id, { tools: this.toolsList.map(({ execute: _execute, ...tool }) => tool) }) };
    }
    if (method === "resources/list") return { response: response(id, { resources: [] }) };
    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      const input = params.arguments ?? {};
      const tool = this.toolsList.find((candidate) => candidate.name === name);
      if (!tool) return { response: rpcError(id, -32602, `unknown tool: ${name}`) };
      try {
        const value = boundMcpResult(await tool.execute(input));
        return {
          response: response(id, {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          }),
        };
      } catch (error) {
        const details = errorInfo(error);
        return {
          response: response(id, {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: details }) }],
            structuredContent: { ok: false, error: details },
          }),
        };
      }
    }
    if (method === "logging/setLevel") return { response: response(id, {}) };
    if (!method) return { response: rpcError(id, -32600, "method is required") };
    return { response: rpcError(id, -32601, `method not found: ${method}`) };
  }

  private buildTools(): McpTool[] {
    const common = CORE_TOOL_SPECS.flatMap((entry) => {
      const operation = this.operationById.get(entry.operationId);
      if (!operation) return [];
      return [{
        name: entry.name,
        description: `${entry.description} Risk: ${operation.risk}.`,
        inputSchema: entry.inputSchema,
        execute: async (raw: unknown) => {
          const input = asObject(raw);
          assertRequiredFields(entry.inputSchema, input, entry.name);
          if (operation.risk === "dangerous" && input.confirm !== true) {
            throw Object.assign(new Error(`confirm=true is required for ${operation.id}`), { code: "CONFIRMATION_REQUIRED" });
          }
          return this.invokeOperation(operation, entry.toArgs(input));
        },
      } satisfies McpTool];
    });
    const generic: McpTool = {
      name: "pi_desktop_invoke",
      description: "Invoke a reviewed PI-Desktop operation. Use pi_control_describe for ids and argument shapes. Dangerous operations require confirm=true. This is an agent acknowledgement, not a user prompt.",
      inputSchema: objectSchema({
        operation: {
          type: "string",
          enum: this.operations.map((operation) => operation.id),
          description: "IPC operation path, for example session/create or project/set.",
        },
        args: {
          type: "array",
          items: anySchema(),
          description: "Positional IPC arguments in the renderer API order.",
        },
        confirm: booleanSchema("Required acknowledgement for dangerous operations."),
      }, ["operation"]),
      execute: async (raw) => {
        const input = asObject(raw);
        const operationId = typeof input.operation === "string" ? input.operation : "";
        const operation = this.operationById.get(operationId);
        if (!operation) throw Object.assign(new Error(`operation is not exposed: ${operationId}`), { code: "NOT_FOUND" });
        const args = input.args === undefined ? [] : input.args;
        if (!Array.isArray(args)) throw Object.assign(new Error("args must be an array"), { code: "INVALID_PARAMS" });
        if (args.length > MAX_ARGUMENT_ITEMS) throw Object.assign(new Error("too many IPC arguments"), { code: "INVALID_PARAMS" });
        if (operation.risk === "dangerous" && input.confirm !== true) {
          throw Object.assign(new Error(`confirm=true is required for ${operation.id}`), { code: "CONFIRMATION_REQUIRED" });
        }
        const result = await this.controller.invoke({
          operation: operation.id,
          args,
          confirm: input.confirm === true,
        });
        return { operation: operation.id, result };
      },
    };
    const describe: McpTool = {
      name: "pi_control_describe",
      description: "Return the reviewed PI-Desktop operation catalog.",
      inputSchema: objectSchema({}),
      execute: async () => this.operations.map((operation) => ({
        id: operation.id,
        risk: operation.risk,
        description: operation.description,
        argumentShape: operation.argumentShape,
      })),
    };
    return [generic, describe, ...common];
  }

  private async invokeOperation(operation: McpControlOperation, args: readonly unknown[]): Promise<unknown> {
    return this.controller.invoke({ operation: operation.id, args, confirm: true });
  }

  private sessionId(request: IncomingMessage): string | null {
    return this.headerValue(request, "mcp-session-id");
  }

  private readJson(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        request.destroy();
        reject(error);
      };
      request.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_REQUEST_BYTES) {
          fail(new Error("MCP request exceeds 2 MiB"));
          return;
        }
        chunks.push(buffer);
      });
      request.on("end", () => {
        if (settled) return;
        settled = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
      request.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  private sendHttp(
    result: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    result.writeHead(status, { "Content-Type": "application/json", ...headers });
    result.end(JSON.stringify(body));
  }

  private sendJsonRpc(
    result: ServerResponse,
    body: JsonRpcResponse,
    headers: Record<string, string> = {},
  ): void {
    result.writeHead(200, { "Content-Type": "application/json", ...headers });
    result.end(JSON.stringify(body));
  }
}

export const MCP_CONTROL_DEFAULT_PORT = DEFAULT_PORT;
export const MCP_CONTROL_PROTOCOL_VERSION = MCP_PROTOCOL_VERSION;
