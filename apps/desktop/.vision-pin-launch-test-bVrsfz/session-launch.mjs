// electron/main/runtime/session-launch.ts
import { join as join2 } from "node:path";
import {
  capabilitiesFromModelConfig as capabilitiesFromModelConfig2,
  clampThinkingLevel,
  loadCustomSystemPrompt,
  loadInstructionChain,
  loadSubagentDefinitions,
  modelConfigWithBinding as modelConfigWithBinding3,
  optionalProviderHeaders,
  resolveSubagentProviders,
  visionFromModelConfig
} from "@pi-desktop/agent-runtime";
import {
  GEN_UI_DIRECTORY_NAME,
  isActiveInProject,
  isCommandShellCatalog,
  JEV_API_KEY_SECRET_REF,
  normalizeMode,
  ErrorCodes as SharedErrorCodes,
  trustedExtensionAgentKeyFromProviderId
} from "@pi-desktop/shared";

// electron/main/bootstrap/remote-hosts.ts
import {
  IPC as IPC4,
  isCommandShellOption
} from "@pi-desktop/shared";
import { wsClientTransport as wsClientTransport2 } from "@pi-desktop/racp";

// electron/main/remote/backend-router.ts
var ROUTE_LOCAL = Symbol("pi-desktop.route-local");

// electron/main/remote/racp-remote-host-client.ts
import {
  RacpClient,
  wsClientTransport
} from "@pi-desktop/racp";
import { ErrorCodes } from "@pi-desktop/shared";

// electron/main/remote/ssh-transport.ts
import { ErrorCodes as ErrorCodes3 } from "@pi-desktop/shared";

// electron/main/remote/ssh-askpass.ts
import { ErrorCodes as ErrorCodes2 } from "@pi-desktop/shared";
var ASKPASS_SECRET_ENV = "PI_SSH_ASKPASS_SECRET";
var ASKPASS_HELPER_SCRIPT = `#!/bin/sh
# Written by the desktop app; do not edit. Reads the secret from a 0600 file
# so it never appears in the process list.
cat "\${${ASKPASS_SECRET_ENV}}"
echo
`;

// electron/main/remote/remote-host-realign.ts
var REALIGN_RETRY_AFTER_MS = 10 * 60 * 1e3;

// electron/main/remote/ssh-bootstrap.ts
import {
  ErrorCodes as ErrorCodes5
} from "@pi-desktop/shared";

// electron/main/remote/pi-host-release.ts
import { GITHUB_REPO } from "@pi-desktop/shared";

// electron/main/remote/ssh-tunnel.ts
import { RACP_WS_PATH } from "@pi-desktop/shared";

// electron/main/remote/ssh-artifact-transfer.ts
import { ErrorCodes as ErrorCodes4 } from "@pi-desktop/shared";
var MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

// electron/main/remote/remote-host-connection.ts
import { IPC as IPC3, RACP_DEFAULT_LIMITS } from "@pi-desktop/shared";

// electron/main/remote/remote-backend.ts
import { ErrorCodes as ErrorCodes6, IPC } from "@pi-desktop/shared";

// electron/main/remote/remote-history.ts
var nextCursor = 2 ** 48;

// electron/main/remote/remote-backend.ts
var HANDLED_CHANNELS = /* @__PURE__ */ new Set([
  IPC.invoke.agentPrompt,
  IPC.invoke.agentQueuePush,
  IPC.invoke.agentQueueList,
  IPC.invoke.agentQueueRemove,
  IPC.invoke.agentStop,
  IPC.invoke.agentAbort,
  IPC.invoke.agentCompact,
  IPC.invoke.agentGetStatus,
  IPC.invoke.agentSteer,
  IPC.invoke.sessionGet,
  IPC.invoke.sessionConfigure,
  IPC.invoke.sessionFork,
  IPC.invoke.sessionRename,
  IPC.invoke.sessionDeriveTitle,
  IPC.invoke.sessionDelete,
  IPC.invoke.toolResolvePermission,
  IPC.invoke.askToolResolve,
  IPC.invoke.plansResolve,
  IPC.invoke.plansPending,
  IPC.invoke.fsList,
  IPC.invoke.fsRead,
  IPC.invoke.workspaceDiff
]);

// electron/main/remote/remote-event-bridge.ts
import { IPC as IPC2 } from "@pi-desktop/shared";

// electron/main/remote/remote-subscriptions.ts
import { isDurableEventKind } from "@pi-desktop/shared";

// electron/main/remote/remote-provider-sync.ts
import {
  ErrorCodes as ErrorCodes7,
  PROVIDER_SYNC_MAX_PROVIDERS,
  isSyncableProvider,
  parseProviderImportPayload,
  parseProviderImportSummary
} from "@pi-desktop/shared";
var OUTPUT_MAX_BYTES = 64 * 1024;

// electron/main/bootstrap/remote-hosts.ts
var activeRemoteHostsBoot = null;
function getActiveRemoteHostsBoot() {
  return activeRemoteHostsBoot;
}

// electron/main/builtin-skills.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFrontmatter } from "@pi-desktop/plugin-sdk";
import { GEN_UI_SKILL_ID } from "@pi-desktop/shared";

// electron/main/module-path.ts
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
function getModuleDirectory(moduleUrl) {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (basename(directory) === "chunks") directory = dirname(directory);
  return directory;
}

// electron/main/plugin-workspace-contains.ts
function pluginWorkspaceContains(workspacePath, pluginPath) {
  const fold = (value) => {
    const unified = value.replace(/\\/g, "/").replace(/^\/\/\?\/(?=[a-z]:\/)/i, "");
    const trimmed = unified.replace(/\/+$/, "");
    const rooted = trimmed === "" && unified.startsWith("/") ? "/" : trimmed;
    return process.platform === "linux" ? rooted : rooted.toLowerCase();
  };
  const workspace = fold(workspacePath);
  if (!workspace) return false;
  const plugin = fold(pluginPath);
  if (workspace === "/") return plugin.startsWith("/");
  return plugin === workspace || plugin.startsWith(`${workspace}/`);
}

// electron/main/builtin-skills.ts
var PLUGIN_DEV_SKILL_FILE = "plugin-development.md";
var PLUGIN_DEV_SKILL_ID = "pi-desktop/plugin-development";
var IMAGE_GENERATION_SKILL_ID = "pi-desktop/imagegen";
var IMAGE_GENERATION_SKILL_FILE = "image-generation.md";
var VISUALIZE_SKILL_ID = GEN_UI_SKILL_ID;
var VISUALIZE_SKILL_FILE = "visualize.md";
function resolveBuiltinSkillPath(fileName) {
  const moduleDir = getModuleDirectory(import.meta.url);
  const candidates = [
    join(process.resourcesPath || "", "skills", fileName),
    join(moduleDir, "../../resources/skills", fileName),
    join(moduleDir, "../../../resources/skills", fileName)
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}
function isPluginWorkspace(workspacePath, pluginPaths = []) {
  if (!workspacePath) return false;
  const manifestPath = join(workspacePath, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest && typeof manifest === "object" && typeof manifest.schemaVersion === "number" && typeof manifest.main === "string") {
        return true;
      }
    } catch {
    }
  }
  return pluginPaths.some((pluginPath) => pluginWorkspaceContains(workspacePath, pluginPath));
}
function readBuiltinSkill(fileName) {
  const path = resolveBuiltinSkillPath(fileName);
  if (!path) return null;
  try {
    return { path, raw: readFileSync(path, "utf8") };
  } catch {
    return null;
  }
}
var BUILTIN_SKILL_FILES = [
  [IMAGE_GENERATION_SKILL_ID, IMAGE_GENERATION_SKILL_FILE],
  [VISUALIZE_SKILL_ID, VISUALIZE_SKILL_FILE],
  [PLUGIN_DEV_SKILL_ID, PLUGIN_DEV_SKILL_FILE]
];
function builtinSkillCatalog() {
  return BUILTIN_SKILL_FILES.flatMap(([id, file]) => {
    const raw = readBuiltinSkill(file);
    if (!raw?.raw.trim()) return [];
    const parsed = parseSkillFrontmatter(raw.raw);
    return parsed.body ? [{ id, name: parsed.name ?? id, description: parsed.description }] : [];
  });
}
function builtinSkills(input) {
  const ids = [IMAGE_GENERATION_SKILL_ID];
  if (!input.remote) ids.push(VISUALIZE_SKILL_ID);
  if (isPluginWorkspace(input.workspacePath, input.pluginPaths)) ids.push(PLUGIN_DEV_SKILL_ID);
  const activeIds = new Set(ids);
  const disabled = new Set(input.disabledIds ?? []);
  return builtinSkillCatalog().filter(
    (skill) => activeIds.has(skill.id) && !disabled.has(skill.id)
  );
}
function effectiveDisabledBuiltinSkills(disabled, visualizations) {
  if (visualizations || disabled.includes(VISUALIZE_SKILL_ID)) return [...disabled];
  return [...disabled, VISUALIZE_SKILL_ID];
}

// electron/main/models-dev-catalog.ts
import {
  createModels,
  InMemoryModelsStore
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  MODEL_VENDOR_PREFIXES,
  NAMED_ENDPOINT_PRESETS,
  catalogModelIdsMatch,
  stripReleaseSuffix,
  stripVariantSuffix
} from "@pi-desktop/shared";
import { genericModelConfig, modelConfigWithBinding, transcriptConfigFromPi } from "@pi-desktop/agent-runtime";
import { resolveBindingLimits } from "@pi-desktop/shared";
var DEFAULT_CONTEXT_WINDOW = 128e3;
var DEFAULT_MAX_TOKENS = 8192;
var THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 4294967295 ? value : void 0;
}
function positiveInteger(value) {
  const number = nonNegativeInteger(value);
  return number !== void 0 && number > 0 ? number : void 0;
}
function normalizeThinkingValue(value) {
  if (value === "none") return "off";
  return typeof value === "string" && THINKING_LEVELS.includes(value) ? value : void 0;
}
function thinkingLevelMapFromModelsDev(options, levels) {
  if (!options?.length) return void 0;
  const map = {};
  for (const option of options) {
    if (option.type === "toggle" || option.type === "budget_tokens") {
      if (levels.includes("off")) map.off = "none";
      if (levels.includes("medium")) map.medium = "medium";
    }
    for (const value of option.values ?? []) {
      const level = normalizeThinkingValue(value);
      if (level && typeof value === "string") map[level] = value;
    }
  }
  if (Object.keys(map).length > 0 && map.off === void 0 && !levels.includes("off")) {
    map.off = null;
  }
  return Object.keys(map).length > 0 ? map : void 0;
}
function normalizedProviderKey(value) {
  return (value ?? "").trim().toLowerCase().replace(/_/g, "-");
}
var KNOWN_PROVIDER_BASE_URLS = {
  openai: ["https://api.openai.com/v1", "https://chatgpt.com/backend-api"],
  anthropic: ["https://api.anthropic.com"],
  google: ["https://generativelanguage.googleapis.com/v1beta"],
  mistral: ["https://api.mistral.ai/v1"],
  xai: ["https://api.x.ai/v1"],
  groq: ["https://api.groq.com/openai/v1"],
  togetherai: ["https://api.together.xyz/v1"],
  deepseek: ["https://api.deepseek.com"],
  openrouter: ["https://openrouter.ai/api/v1"],
  "fireworks-ai": ["https://api.fireworks.ai/inference/v1"],
  "alibaba-cn": ["https://dashscope.aliyuncs.com/compatible-mode/v1"],
  "moonshotai-cn": ["https://api.moonshot.cn/v1"],
  "siliconflow-cn": ["https://api.siliconflow.cn/v1"],
  volcengine: ["https://ark.cn-beijing.volces.com/api/v3"],
  // MiniMax exposes both an Anthropic endpoint (the published models.dev
  // URL) and an OpenAI-compatible `/v1` endpoint. Treat the latter as the
  // same provider so a custom OpenAI-style row still inherits M3's vision
  // metadata instead of falling back to a text-only generic model.
  "minimax-cn": [
    "https://api.minimaxi.com/v1",
    "https://api.minimaxi.com/anthropic/v1"
  ],
  minimax: [
    "https://api.minimax.io/v1",
    "https://api.minimax.io/anthropic/v1"
  ]
};
var PROVIDER_ALIASES = {
  // pi-ai names the ChatGPT subscription adapter `openai-codex`, while
  // models.dev publishes its model metadata under `openai`. Keep the
  // transport identity in provider config, but resolve metadata through the
  // corresponding public catalog provider.
  "openai-codex": ["openai", "openai-codex"],
  "openai-codex-responses": ["openai", "openai-codex"],
  together: ["together", "togetherai"],
  "together-ai": ["together", "togetherai"],
  fireworks: ["fireworks", "fireworks-ai"],
  "fireworks-ai": ["fireworks", "fireworks-ai"],
  kimi: ["kimi-for-coding", "kimi-coding"],
  "kimi-coding": ["kimi-coding", "kimi-for-coding"],
  "google-vertex": ["google-vertex"],
  "azure-openai-responses": ["azure", "azure-cognitive-services"],
  "vercel-ai-gateway": ["vercel"],
  "zai-coding-cn": ["zhipuai-coding-plan", "zai-coding-cn"],
  "zhipuai-coding-plan": ["zhipuai-coding-plan", "zai-coding-cn"],
  zhipu: ["zhipuai"],
  bigmodel: ["zhipuai"],
  dashscope: ["alibaba-cn"],
  qwen: ["alibaba-cn"],
  moonshot: ["moonshotai-cn", "moonshotai"],
  doubao: ["volcengine"],
  ark: ["volcengine"],
  minimax: ["minimax-cn", "minimax"],
  "lm-studio": ["lmstudio", "lm-studio"],
  lmstudio: ["lmstudio", "lm-studio"]
};
function providerKeyCandidates(value) {
  const key = normalizedProviderKey(value);
  return [.../* @__PURE__ */ new Set([key, ...PROVIDER_ALIASES[key] ?? []])].filter(Boolean);
}
var SUPPORTED_PUBLISHER_KEYS = new Set(
  [
    ...NAMED_ENDPOINT_PRESETS.map((preset) => preset.vendorKey),
    ...Object.keys(KNOWN_PROVIDER_BASE_URLS)
  ].flatMap((key) => providerKeyCandidates(key))
);
function adapterInput(modalities) {
  const input = modalities.input.filter(
    (item) => item === "text" || item === "image"
  );
  return input.includes("text") ? input : ["text"];
}
function modelConfigFromModelsDev(model, baseUrl) {
  const contextWindow = positiveInteger(model.limit.context) ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = positiveInteger(model.limit.output) ?? DEFAULT_MAX_TOKENS;
  const reasoning = model.reasoningPublished ? model.reasoning : false;
  const thinkingLevels = reasoning ? [...model.thinkingLevels] : [];
  const cost = {
    input: model.cost?.input ?? 0,
    output: model.cost?.output ?? 0,
    cacheRead: model.cost?.cacheRead ?? 0,
    cacheWrite: model.cost?.cacheWrite ?? 0,
    ...model.cost?.reasoning !== void 0 ? { reasoning: model.cost.reasoning } : {},
    ...model.cost?.inputAudio !== void 0 ? { inputAudio: model.cost.inputAudio } : {},
    ...model.cost?.outputAudio !== void 0 ? { outputAudio: model.cost.outputAudio } : {},
    ...model.cost?.contextOver200k ? { contextOver200k: model.cost.contextOver200k } : {},
    ...model.cost?.tiers ? { tiers: model.cost.tiers } : {}
  };
  const config = {
    source: "models.dev",
    name: model.displayName,
    baseUrl: baseUrl ?? model.providerApi ?? "",
    reasoning,
    supportedThinkingLevels: thinkingLevels,
    modalities: model.modalities,
    limit: {
      ...model.limit,
      context: model.limit.context ?? contextWindow,
      input: model.limit.input ?? contextWindow,
      output: model.limit.output ?? maxTokens
    },
    cost,
    input: adapterInput(model.modalities),
    contextWindow,
    maxTokens
  };
  if (model.description !== void 0) config.description = model.description;
  if (model.family !== void 0) config.family = model.family;
  if (model.attachment !== void 0) config.attachment = model.attachment;
  if (model.reasoningOptions !== void 0) config.reasoningOptions = model.reasoningOptions;
  if (model.thinkingProtocol !== void 0) config.thinkingProtocol = model.thinkingProtocol;
  const thinkingLevelMap = thinkingLevelMapFromModelsDev(model.reasoningOptions, thinkingLevels);
  if (thinkingLevelMap) config.thinkingLevelMap = thinkingLevelMap;
  if (model.toolCall !== void 0) config.toolCall = model.toolCall;
  if (model.structuredOutput !== void 0) config.structuredOutput = model.structuredOutput;
  if (model.temperature !== void 0) config.temperature = model.temperature;
  if (model.knowledge !== void 0) config.knowledge = model.knowledge;
  if (model.releaseDate !== void 0) config.releaseDate = model.releaseDate;
  if (model.lastUpdated !== void 0) config.lastUpdated = model.lastUpdated;
  if (model.openWeights !== void 0) config.openWeights = model.openWeights;
  if (model.interleaved !== void 0) config.interleaved = model.interleaved;
  if (model.status !== void 0) config.status = model.status;
  if (model.experimental !== void 0) config.experimental = model.experimental;
  if (model.provider !== void 0) {
    config.provider = model.provider;
    config.catalogProvider = model.provider;
  }
  if (model.modelApi !== void 0) config.api = model.modelApi;
  return config;
}
function catalogModelConfigFor(catalog, input) {
  if (catalog.modelConfigFor) return catalog.modelConfigFor(input);
  const model = catalog.findModel(input);
  if (!model) {
    const generic = genericModelConfig(input.modelId, input.baseUrl ?? "");
    const thinking2 = input.apiStyle === "anthropic_messages" ? catalog.anthropicThinkingFor?.(input.modelId) : void 0;
    return thinking2 ? { ...generic, ...thinking2 } : generic;
  }
  const config = modelConfigFromModelsDev(model, input.baseUrl);
  const thinking = input.apiStyle === "anthropic_messages" && !config.reasoningOptions?.length ? catalog.anthropicThinkingFor?.(input.modelId) : void 0;
  return thinking ? { ...config, ...thinking } : config;
}

// electron/main/oauth.ts
import { InMemoryModelsStore as InMemoryModelsStore2 } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  capabilitiesFromModelConfig,
  genericModelConfig as genericModelConfig2,
  installProviderHeadersFetch,
  modelConfigWithBinding as modelConfigWithBinding2,
  runWithProviderHeaders
} from "@pi-desktop/agent-runtime";
import {
  OAUTH_AUTH_KIND
} from "@pi-desktop/shared";

// electron/main/remote/remote-workspace-instructions.ts
var SOURCES = /* @__PURE__ */ new Set(["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"]);
async function loadRemoteWorkspaceInstructions(files, workspace, defaults) {
  const value = await files(workspace.hostKey, { path: workspace.path, operation: "instructions" });
  const invalid = () => {
    throw Object.assign(new Error("Remote Host returned invalid repository instructions"), { errorCode: "INVALID_ARGUMENT" });
  };
  if (!value || typeof value !== "object" || !("entries" in value) || !Array.isArray(value.entries) || value.entries.length > 1) return invalid();
  const entries = value.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || !("source" in entry) || !("content" in entry) || typeof entry.source !== "string" || !SOURCES.has(entry.source) || typeof entry.content !== "string" || Buffer.byteLength(entry.content, "utf8") > 33280) return invalid();
    return { source: entry.source, content: entry.content };
  });
  const merged = [...defaults?.entries ?? [], ...entries];
  return merged.length ? { entries: merged } : void 0;
}

// electron/main/runtime/session-launch.ts
var ErrorCodes8 = {
  ...SharedErrorCodes,
  COMMAND_SHELL_INVALID: "COMMAND_SHELL_INVALID",
  SHELL_NOT_FOUND: "SHELL_NOT_FOUND",
  PLAN_EXECUTION_INTERRUPTED: "PLAN_EXECUTION_INTERRUPTED",
  PLAN_PERMISSION_MODE_REQUIRED: "PLAN_PERMISSION_MODE_REQUIRED"
};
function createSessionLaunchRuntime({
  runtimeState,
  logger,
  userMcp,
  plugins,
  sessionProjects,
  dataDir,
  vendorOAuth,
  modelsDevCatalog,
  getWorkspacePath,
  pluginActiveInProject,
  bindingForModel,
  effectiveSubagentModelConfig,
  normalizeThinkingLevel
}) {
  const isHostUnavailable = (error) => error?.errorCode === ErrorCodes8.HOST_UNAVAILABLE;
  async function refreshUserMcp(projectPath = getWorkspacePath()) {
    if (!runtimeState.host?.isAvailable()) return [];
    try {
      const result = await runtimeState.host.call("mcp.active", {
        projectPath: projectPath ?? null
      });
      const servers = result.servers ?? [];
      userMcp.setRecords(servers);
      return servers;
    } catch (error) {
      if (!isHostUnavailable(error)) {
        logger.app("plugin", "warn", "mcp active list failed", { data: String(error) });
      }
      return [];
    }
  }
  async function activeUserSkills(projectPath) {
    if (!runtimeState.host?.isAvailable()) return [];
    try {
      const result = await runtimeState.host.call("skills.active", {
        projectPath: projectPath ?? null
      });
      return result.skills ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) {
        logger.app("plugin", "warn", "skills list failed", { data: String(error) });
      }
      return [];
    }
  }
  async function activeUserSubagentDocuments(projectPath) {
    if (!runtimeState.host?.isAvailable()) return [];
    let records = [];
    try {
      const result = await runtimeState.host.call(
        "agents.active",
        { projectPath: projectPath ?? null }
      );
      records = result.subagents ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) {
        logger.app("plugin", "warn", "subagent list failed", { data: String(error) });
      }
      return [];
    }
    const documents = [];
    const { readFile } = await import("node:fs/promises");
    for (const record of records) {
      try {
        documents.push({
          id: record.id,
          document: await readFile(record.path, "utf8"),
          filePath: record.path
        });
      } catch (error) {
        logger.app("plugin", "warn", "subagent document unreadable", {
          data: { id: record.id, error: String(error) }
        });
      }
    }
    return documents;
  }
  async function disabledBuiltinSubagents() {
    if (!runtimeState.host?.isAvailable()) return [];
    try {
      const result = await runtimeState.host.call(
        "agents.disabledBuiltins"
      );
      return result.disabled ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) {
        logger.app("plugin", "warn", "builtin subagent state failed", {
          data: String(error)
        });
      }
      return [];
    }
  }
  async function disabledBuiltinSkills() {
    if (!runtimeState.host?.isAvailable()) {
      throw new Error("host unavailable while reading built-in skill activation");
    }
    try {
      const result = await runtimeState.host.call(
        "skills.disabledBuiltins"
      );
      return result.disabled ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) {
        logger.app("plugin", "warn", "builtin skill state failed", {
          data: String(error)
        });
      }
      throw error;
    }
  }
  async function runtimeDisabledBuiltinSkills() {
    const disabled = await disabledBuiltinSkills();
    let visualizations = false;
    if (runtimeState.host?.isAvailable()) {
      try {
        const settings = await runtimeState.host.call(
          "settings.get"
        );
        visualizations = settings.inlineVisualizations === true;
      } catch (error) {
        if (!isHostUnavailable(error)) {
          logger.app("plugin", "warn", "visualization switch failed", {
            data: String(error)
          });
        }
      }
    }
    return effectiveDisabledBuiltinSkills(disabled, visualizations);
  }
  async function loadUserSkillBody(id, projectPath) {
    if (!runtimeState.host || id.includes("/")) return null;
    const result = await runtimeState.host.call("skills.read", { id, projectPath });
    const skill = result.skill;
    if (!skill || typeof result.body !== "string") return null;
    if (!isActiveInProject(skill, projectPath)) {
      throw new Error(`skill "${id}" is not enabled for this project`);
    }
    return { id: skill.id, name: skill.name, body: result.body, location: skill.path };
  }
  async function resolveEffectiveCommandShell() {
    if (!runtimeState.host) throw new Error("host unavailable");
    const catalog = await runtimeState.host.call("commandShells.list");
    if (!isCommandShellCatalog(catalog)) {
      throw Object.assign(new Error("Host returned an invalid command shell catalog"), {
        errorCode: ErrorCodes8.COMMAND_SHELL_INVALID
      });
    }
    if (!catalog.effective || !catalog.effective.available) {
      throw Object.assign(
        new Error("No available command shell is configured for this session"),
        { errorCode: ErrorCodes8.SHELL_NOT_FOUND }
      );
    }
    return catalog;
  }
  async function isolatedWorkspaceRoot(sessionId, session) {
    if (!session?.worktree) return void 0;
    if (!runtimeState.host) throw new Error("host unavailable");
    const result = await runtimeState.host.call("worktree.location", {
      sessionId
    });
    const root = typeof result.path === "string" ? result.path.trim() : "";
    if (!root) throw new Error("isolated worktree location unavailable");
    return root;
  }
  async function resolveAgentRuntimeLaunch(sessionId, session, settings, overrides = {}) {
    if (!runtimeState.host) throw new Error("host unavailable");
    await modelsDevCatalog.ensureLoaded();
    const remoteWorkspace = session.remoteWorkspace;
    const remoteBoot = remoteWorkspace ? getActiveRemoteHostsBoot() : null;
    if (remoteWorkspace && !remoteBoot) throw new Error("remote host unavailable");
    const commandShell = remoteWorkspace ? await remoteBoot.workspaceCommandShell(remoteWorkspace.hostKey) : (await resolveEffectiveCommandShell()).effective;
    const providers = await runtimeState.host.call(
      "providers.list",
      { includeDisabled: false }
    );
    for (const row of providers.providers) modelsDevCatalog.configureAccount(row);
    const requestedProviderId = overrides.providerId ?? session.providerId;
    const extensionAgentKey = requestedProviderId ? trustedExtensionAgentKeyFromProviderId(requestedProviderId) : void 0;
    const provider = extensionAgentKey ? {
      id: requestedProviderId,
      name: "Plugin agent",
      modelId: overrides.modelId ?? session.modelId,
      authKind: "none",
      extensionAgentKey
    } : requestedProviderId ? providers.providers.find((item) => item.id === requestedProviderId && item.enabled !== false) : providers.providers.find((item) => item.id === settings.defaultProviderId) || providers.providers.find(
      (item) => item.hasSecret || item.hasOauth || item.authKind === "none"
    ) || providers.providers[0];
    if (!provider) {
      throw Object.assign(new Error("No provider configured"), {
        errorCode: ErrorCodes8.MODEL_NOT_CONFIGURED
      });
    }
    modelsDevCatalog.configureAccount(provider);
    const isExtensionAgent = Boolean(extensionAgentKey);
    const isVendorAccount = !isExtensionAgent && provider.authKind === OAUTH_AUTH_KIND;
    const secret = isExtensionAgent || isVendorAccount ? { value: void 0 } : await runtimeState.host.call("providers.getSecret", {
      id: provider.id
    });
    if (!secret.value && !isExtensionAgent && !isVendorAccount && provider.authKind !== "none") {
      throw Object.assign(new Error("Provider API key missing"), {
        errorCode: ErrorCodes8.PROVIDER_SECRET_MISSING
      });
    }
    const modelId = isExtensionAgent ? overrides.modelId ?? session.modelId : (provider.id === requestedProviderId ? overrides.modelId ?? session.modelId : void 0) || (provider.id === settings.defaultProviderId ? settings.defaultModelId : void 0) || provider.models?.[0]?.id || provider.defaultModelId;
    if (!modelId) {
      throw Object.assign(new Error("No model selected for provider"), {
        errorCode: ErrorCodes8.MODEL_NOT_CONFIGURED
      });
    }
    const vendorBinding = isVendorAccount ? await vendorOAuth.bindingFor(provider.id, modelId).catch(() => void 0) : void 0;
    if (isVendorAccount && !vendorBinding) {
      throw Object.assign(
        new Error(`Vendor account does not offer model "${modelId}"`),
        { errorCode: ErrorCodes8.MODEL_NOT_CONFIGURED }
      );
    }
    const storedModel = bindingForModel(provider, modelId);
    const apiStyle = vendorBinding?.apiStyle ?? provider.apiStyle;
    const baseUrl = vendorBinding?.baseUrl ?? provider.baseUrl;
    const catalogModelConfig = vendorBinding?.modelConfig ?? catalogModelConfigFor(modelsDevCatalog, {
      providerId: provider.id,
      vendorKey: provider.vendorKey,
      baseUrl,
      apiStyle,
      modelId
    });
    const modelConfig = storedModel ? modelConfigWithBinding3(catalogModelConfig, storedModel) : catalogModelConfig;
    const thinkingCapabilities = capabilitiesFromModelConfig2(modelConfig);
    const thinkingLevel = clampThinkingLevel(
      thinkingCapabilities,
      normalizeThinkingLevel(
        overrides.thinkingLevel ?? (provider.id === requestedProviderId ? session.thinkingLevel : void 0) ?? storedModel?.defaultThinkingLevel
      )
    );
    const projectPath = typeof session.projectPath === "string" && session.projectPath.trim() ? session.projectPath.trim() : void 0;
    const localInstructionRoot = remoteWorkspace ? void 0 : projectPath;
    const workspaceRoot = remoteWorkspace ? void 0 : await isolatedWorkspaceRoot(sessionId, session);
    let projectInstructions = await loadInstructionChain(
      remoteWorkspace ? void 0 : workspaceRoot ?? projectPath
    );
    if (remoteWorkspace) {
      projectInstructions = await loadRemoteWorkspaceInstructions(
        remoteBoot.workspaceFiles,
        remoteWorkspace,
        projectInstructions
      );
    }
    const customSystemPrompt = await loadCustomSystemPrompt(localInstructionRoot);
    let projectMemory;
    if (projectPath) {
      try {
        const result = await runtimeState.host.call("project.group.context", { path: projectPath });
        const groupRoots = result.context?.roots ?? [];
        const groupRootGuide = !workspaceRoot && groupRoots.length > 1 ? [
          `Primary root: ${groupRoots[0]?.path ?? projectPath}`,
          ...groupRoots.slice(1).map((root) => `Additional root: ${root.path}`),
          "Use an absolute path when reading or editing an additional root."
        ].join("\n") : "";
        const groupInstructions = result.context?.instructions?.trim();
        if (groupRootGuide || groupInstructions) {
          projectInstructions = {
            entries: [
              ...projectInstructions?.entries ?? [],
              ...groupRootGuide ? [{ source: "ChatGPT Project folders", content: groupRootGuide }] : [],
              ...groupInstructions ? [{ source: "ChatGPT Project instructions", content: groupInstructions }] : []
            ]
          };
        }
        const groupMemory = result.context?.memory?.content?.trim();
        if (groupMemory) projectMemory = groupMemory;
        if (!result.context) {
          const legacy = await runtimeState.host.call("project.memory.get", { path: projectPath });
          const content = legacy.memory?.content?.trim();
          if (content) projectMemory = content;
        }
      } catch {
        try {
          const legacy = await runtimeState.host.call("project.memory.get", { path: projectPath });
          const content = legacy.memory?.content?.trim();
          if (content) projectMemory = content;
        } catch {
        }
      }
    }
    sessionProjects.set(sessionId, projectPath ?? null);
    const userSkills = await activeUserSkills(projectPath);
    await refreshUserMcp(projectPath);
    const userMcpTools = await userMcp.toolsForProject(projectPath ?? null);
    const disabledSkillIds = effectiveDisabledBuiltinSkills(
      await disabledBuiltinSkills(),
      settings.inlineVisualizations === true
    );
    const pluginSkills = [
      ...builtinSkills({
        workspacePath: projectPath,
        pluginPaths: plugins.listLoaded().map((loaded) => loaded.path),
        disabledIds: disabledSkillIds,
        remote: Boolean(remoteWorkspace)
      }),
      ...plugins.getSkills().filter((skill) => pluginActiveInProject(skill.pluginId, projectPath)).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description
      })),
      ...userSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description
      }))
    ];
    const subagentCatalog = await loadSubagentDefinitions(localInstructionRoot, {
      userDocuments: await activeUserSubagentDocuments(projectPath),
      // A switched-off builtin is dropped from what this prompt may delegate to.
      disabledBuiltins: await disabledBuiltinSubagents()
    });
    const subagentBindings = await resolveSubagentProviders({
      definitions: subagentCatalog.definitions,
      providers: providers.providers,
      getSecret: async (id) => (await runtimeState.host.call("providers.getSecret", { id })).value,
      resolveVendorBinding: (pinned, pinnedModelId) => vendorOAuth.bindingFor(pinned.id, pinnedModelId),
      resolveModel: async (pinned, pinnedModelId) => {
        const catalogModelConfig2 = catalogModelConfigFor(modelsDevCatalog, {
          providerId: pinned.id,
          vendorKey: pinned.vendorKey,
          baseUrl: pinned.baseUrl,
          apiStyle: pinned.apiStyle,
          modelId: pinnedModelId
        });
        const configuredProvider = providers.providers.find(
          (candidate) => candidate.id === pinned.id
        );
        return configuredProvider ? effectiveSubagentModelConfig(
          configuredProvider,
          pinnedModelId,
          catalogModelConfig2
        ) : {
          modelConfig: catalogModelConfig2,
          capabilities: capabilitiesFromModelConfig2(catalogModelConfig2)
        };
      }
    });
    const subagentModelKeys = [];
    for (const row of providers.providers) {
      if (!row.enabled) continue;
      for (const binding of row.models ?? []) {
        if (!binding.availableForSubagents) continue;
        let key = `${row.vendorKey ?? row.name}/${binding.id}`;
        if (subagentBindings.providers[key]?.id && subagentBindings.providers[key].id !== row.id) {
          key = `${row.id}/${binding.id}`;
        }
        if (subagentBindings.providers[key]) {
          subagentModelKeys.push(key);
          continue;
        }
        const isVendorAccount2 = row.authKind === OAUTH_AUTH_KIND;
        let apiKey = "";
        if (!isVendorAccount2 && row.authKind !== "none") {
          try {
            apiKey = (await runtimeState.host.call("providers.getSecret", {
              id: row.id
            })).value ?? "";
          } catch {
            continue;
          }
          if (!apiKey) continue;
        }
        let catalogModelConfig2;
        if (isVendorAccount2) {
          const vb = await vendorOAuth.bindingFor(row.id, binding.id);
          if (!vb) continue;
          catalogModelConfig2 = vb.modelConfig ?? catalogModelConfigFor(modelsDevCatalog, {
            providerId: row.id,
            vendorKey: row.vendorKey,
            baseUrl: vb.baseUrl ?? row.baseUrl,
            apiStyle: vb.apiStyle ?? row.apiStyle,
            modelId: binding.id
          });
        } else {
          catalogModelConfig2 = catalogModelConfigFor(modelsDevCatalog, {
            providerId: row.id,
            vendorKey: row.vendorKey,
            baseUrl: row.baseUrl,
            apiStyle: row.apiStyle,
            modelId: binding.id
          });
        }
        const effective = effectiveSubagentModelConfig(
          row,
          binding.id,
          catalogModelConfig2
        );
        const mc = effective.modelConfig;
        const caps = effective.capabilities;
        subagentBindings.providers[key] = {
          id: row.id,
          name: row.name,
          ...row.vendorKey ? { vendorKey: row.vendorKey } : {},
          ...row.baseUrl ? { baseUrl: row.baseUrl } : {},
          modelId: binding.id,
          apiKey,
          ...row.authKind ? { authKind: row.authKind } : {},
          ...row.apiStyle ? { apiStyle: row.apiStyle } : {},
          ...optionalProviderHeaders(row.headers),
          supportsReasoning: caps.supportsReasoning,
          supportedThinkingLevels: [...caps.supportedThinkingLevels],
          ...mc ? { modelConfig: mc } : {}
        };
        subagentModelKeys.push(key);
      }
    }
    const subagentDiagnostics = [
      ...subagentCatalog.diagnostics,
      ...subagentBindings.diagnostics
    ];
    if (subagentDiagnostics.length > 0) {
      logger.app("session", "warn", "subagent definitions have problems", {
        sessionId,
        data: { diagnostics: subagentDiagnostics }
      });
    }
    runtimeState.sidecar?.setVendorAuthBindings(
      sessionId,
      [
        provider.id,
        ...Object.values(subagentBindings.providers).map((binding) => binding.id)
      ].map((id) => providers.providers.find((row) => row.id === id)).flatMap(
        (row) => row?.authKind === OAUTH_AUTH_KIND ? [{ providerId: row.id }] : []
      )
    );
    const mode = normalizeMode(
      overrides.mode ?? session.mode ?? settings.defaultMode ?? "agent"
    );
    let jevApiKey;
    if (mode === "agent" && settings.jevEnabled === true) {
      try {
        const saved = await runtimeState.host.call(
          "secrets.getForRuntime",
          { secretRef: JEV_API_KEY_SECRET_REF }
        );
        if (typeof saved.value === "string" && saved.value.trim().length > 0) {
          jevApiKey = saved.value;
        }
      } catch {
        logger.app("session", "warn", "Jev API key could not be loaded", {
          sessionId
        });
      }
    }
    return {
      providerId: provider.id,
      modelId,
      projectPath,
      workspaceRoot,
      sidecarParams: {
        sessionId,
        mode,
        ...overrides.turnId ? { turnId: overrides.turnId } : {},
        thinkingLevel,
        infiniteProviderRetry: settings.infiniteProviderRetry === true,
        // The session `/fast` switch only reaches a model the user allowed it
        // for in model settings (ADR 0334).
        fastMode: session.fastMode === true && storedModel?.fastModeAllowed === true,
        ...jevApiKey ? { jevApiKey } : {},
        // A disabled feature is absent from the prompt rather than advertised
        // and refused on every call (ADR 0342 §13).
        ...mode === "agent" && settings.computerUse?.enabled === true ? { computerUseEnabled: true } : {},
        commandShell,
        scratchDir: join2(dataDir, "scratch", sessionId),
        // Remote-host tools write on that host; Main can only serve local files.
        // The feature switch and a disabled visualize skill both withhold the
        // directory, so the prompt never points the model at a skill it cannot
        // load or at a card this build will not render.
        ...remoteWorkspace || disabledSkillIds.includes(VISUALIZE_SKILL_ID) ? {} : { visualizationsDir: join2(dataDir, GEN_UI_DIRECTORY_NAME, sessionId) },
        attachmentsDir: join2(dataDir, "attachments"),
        projectPath,
        ...remoteWorkspace ? { remoteWorkspace } : {},
        ...workspaceRoot ? { workspaceRoot } : {},
        customSystemPrompt,
        projectInstructions,
        projectMemory,
        provider: {
          id: provider.id,
          name: provider.name,
          vendorKey: provider.vendorKey,
          baseUrl,
          modelId,
          apiKey: secret.value || "",
          authKind: provider.authKind,
          extensionAgentKey: provider.extensionAgentKey,
          apiStyle,
          ...optionalProviderHeaders(provider.headers),
          supportsReasoning: thinkingCapabilities.supportsReasoning,
          supportsVision: visionFromModelConfig(modelConfig),
          supportedThinkingLevels: [...thinkingCapabilities.supportedThinkingLevels],
          ...modelConfig ? { modelConfig } : {}
        },
        pluginTools: [
          ...plugins.getTools().filter((tool) => pluginActiveInProject(tool.pluginId, projectPath)).map((tool) => ({
            name: tool.fullName,
            description: tool.description,
            parameters: tool.schema ?? { type: "object", properties: {} },
            ...tool.risk === "low" || tool.risk === "medium" || tool.risk === "high" ? { risk: tool.risk } : {},
            // Plan-safe action list is forwarded to host-core so it can
            // admit the tool in Plan/Goal modes (ADR 0211).
            ...tool.planSafeActions && tool.planSafeActions.length > 0 ? { planSafeActions: tool.planSafeActions } : {}
          })),
          ...userMcpTools.map((tool) => ({
            name: tool.fullName,
            mcpServerId: tool.serverId,
            description: tool.description,
            parameters: tool.schema ?? { type: "object", properties: {} }
          }))
        ],
        // Plugin skills (D174): only the catalog crosses to the sidecar; the
        // document body is fetched on demand through the local `Skill` tool.
        pluginSkills,
        // Trusted extensions enabled for this project (spec 16 §3.2). The set
        // is part of the runtime match, so a toggle retires the runtime.
        trustedExtensions: plugins.getAgentExtensions().filter((extension) => pluginActiveInProject(extension.pluginId, projectPath)).map((extension) => ({
          id: extension.id,
          entry: extension.entry,
          label: extension.pluginName,
          source: "plugin",
          root: extension.root
        })),
        subagents: subagentCatalog.definitions,
        subagentProviders: subagentBindings.providers,
        subagentModelKeys
      }
    };
  }
  return {
    refreshUserMcp,
    activeUserSkills,
    activeUserSubagentDocuments,
    disabledBuiltinSubagents,
    disabledBuiltinSkills,
    runtimeDisabledBuiltinSkills,
    loadUserSkillBody,
    resolveEffectiveCommandShell,
    resolveAgentRuntimeLaunch
  };
}
export {
  createSessionLaunchRuntime
};
