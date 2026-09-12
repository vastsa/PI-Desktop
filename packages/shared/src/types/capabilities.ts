/** Shared public types grouped by the owning application domain. */
import type { ActivationScope } from "../activation.js";
import type { SubagentThinkingLevel } from "./models.js";

/** The filesystem level that owns an agent capability. */
export type AgentCapabilityLevel = "global" | "project";

/** A settings-page query for one capability column. */
export type AgentCapabilityQuery = {
  level: AgentCapabilityLevel;
  projectPath?: string;
};

/** Transport of an MCP server the user configured themselves. */
export type McpTransport = "stdio" | "http";

/**
 * An MCP server the user added directly, without a plugin around it.
 *
 * The shape deliberately mirrors `contributes.mcpServers` (ADR 0038) so both
 * kinds go through one client implementation; what differs is ownership. A user
 * server has no plugin to grant permissions to, so its consent is the act of
 * typing the command or the URL, and its credentials come from `env`/`headers`
 * on the record instead of a plugin's settings.
 */
export type McpServerRecord = {
  id: string;
  label: string;
  /** Filesystem ownership, present for the Agent settings management page. */
  level?: AgentCapabilityLevel;
  /** Project root when `level === "project"`. */
  projectPath?: string;
  /** Absolute config path; never used for activation state. */
  path?: string;
  description?: string;
  transport: McpTransport;
  /** stdio: executable name or absolute path. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: absolute endpoint; HTTP is allowed for local and LAN servers. */
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  scope?: ActivationScope;
  createdAt: string;
  updatedAt: string;
};

/** Fields accepted when creating or editing a user MCP server. */
export type McpServerInput = {
  id: string;
  label?: string;
  level?: AgentCapabilityLevel;
  projectPath?: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  scope?: ActivationScope;
};

export type McpConnectionState = "idle" | "connecting" | "ready" | "failed";

/** Live connection state of one user MCP server, as the Extensions page shows it. */
export type McpServerStatus = {
  serverId: string;
  state: McpConnectionState;
  /** Tools discovered by the last successful `tools/list`. */
  toolCount: number;
  toolNames?: string[];
  message?: string;
  updatedAt: number;
};

/** A user MCP server plus whatever the runtime knows about its connection. */
export type McpServerView = McpServerRecord & {
  status?: McpServerStatus;
};

/**
 * A skill document the user owns, stored under `~/.agents/skills` or a
 * project's `.agents/skills` directory.
 *
 * Reaches the model through the same catalog-plus-`Skill`-tool path as built-in
 * and plugin skills (D174), so the three are indistinguishable once loaded.
 */
export type UserSkillRecord = {
  /** Slug used both as the directory name and as the id the model passes. */
  id: string;
  name: string;
  /** Filesystem ownership, present for the Agent settings management page. */
  level?: AgentCapabilityLevel;
  /** Project root when `level === "project"`. */
  projectPath?: string;
  description?: string;
  enabled: boolean;
  scope?: ActivationScope;
  /** `created` writes a template; `imported` copies an existing document. */
  source: "created" | "imported";
  /** Absolute path of the document, for opening it in the editor. */
  path: string;
  /** Bytes of the document, so the list can flag one that grew past the cap. */
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type UserSkillInput = {
  id?: string;
  name: string;
  level?: AgentCapabilityLevel;
  projectPath?: string;
  description?: string;
  body?: string;
  enabled?: boolean;
  scope?: ActivationScope;
};

/**
 * A global subagent definition the user owns, stored as `~/.agents/subagents/<id>.md`
 * (D202, ADR 0063). Project roots do not provide subagent definitions.
 *
 * `id` and `name` are deliberately the same string: the name
 * is the handle the model passes to `Task`, and keeping the document named after
 * it is what lets the UI tell which source won a name.
 */
export type UserSubagentRecord = {
  id: string;
  name: string;
  /** Subagents are global-only; the level is explicit for the settings API. */
  level?: "global";
  description: string;
  enabled: boolean;
  scope?: ActivationScope;
  /** Resolved tool grant, never empty — what the delegate may actually call. */
  tools: string[];
  /** `<provider>/<model>` pin, resolved against providers at launch. */
  model?: string;
  thinkingLevel?: SubagentThinkingLevel;
  maxTurns?: number;
  /** Output-token cap for one delegate response; omitted follows the model. */
  maxTokens?: number;
  /** Absolute path of the document, for revealing it. */
  path: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type UserSubagentInput = {
  id?: string;
  name?: string;
  description?: string;
  body?: string;
  tools?: string[];
  /** Empty string clears the pin; absent leaves it unchanged. */
  model?: string;
  thinkingLevel?: SubagentThinkingLevel | "";
  /** `0` clears the override; absent leaves it unchanged. */
  maxTurns?: number;
  /** `0` clears the cap; absent leaves it unchanged. */
  maxTokens?: number;
  enabled?: boolean;
  scope?: ActivationScope;
};
