import { join } from "node:path";
import {
  ErrorCodes as SharedErrorCodes,
  isActiveInProject,
  isCommandShellCatalog,
  normalizeMode,
  type CommandShellCatalog,
  type McpServerRecord,
  type ModelBinding,
  type Mode,
  type Risk,
  type ThinkingLevel,
  type UserSkillRecord,
  type UserSubagentRecord,
} from "@pi-desktop/shared";
import {
  capabilitiesFromModelConfig,
  clampThinkingLevel,
  genericModelConfig,
  loadInstructionChain,
  loadSubagentDefinitions,
  modelConfigWithBinding,
  optionalProviderHeaders,
  resolveSubagentProviders,
  visionFromModelConfig,
  type UserSubagentDocument,
} from "@pi-desktop/agent-runtime";
import { builtinSkills } from "../builtin-skills";
import { OAUTH_AUTH_KIND, type VendorOAuth } from "../oauth";
import {
  modelConfigFromModelsDev,
  type ModelsDevCatalog,
} from "../models-dev-catalog";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PluginRuntime } from "../plugin-runtime";
import type { UserMcpRuntime } from "../user-mcp";
import type { RuntimeState } from "./context";
import type { RuntimeProvider } from "./provider-catalog";

const ErrorCodes = {
  ...SharedErrorCodes,
  COMMAND_SHELL_INVALID: "COMMAND_SHELL_INVALID",
  SHELL_NOT_FOUND: "SHELL_NOT_FOUND",
  PLAN_EXECUTION_INTERRUPTED: "PLAN_EXECUTION_INTERRUPTED",
  PLAN_PERMISSION_MODE_REQUIRED: "PLAN_PERMISSION_MODE_REQUIRED",
} as const;

export type SessionLaunchRuntimeDependencies = {
  runtimeState: RuntimeState;
  logger: Logger;
  userMcp: UserMcpRuntime;
  plugins: PluginRuntime;
  sessionProjects: Map<string, string | null>;
  dataDir: string;
  vendorOAuth: VendorOAuth;
  modelsDevCatalog: ModelsDevCatalog;
  getWorkspacePath: () => string | null;
  pluginActiveInProject: (
    pluginId: string,
    projectPath: string | null | undefined,
  ) => boolean;
  bindingForModel: (
    provider: Pick<RuntimeProvider, "models">,
    modelId: string,
  ) => ModelBinding | undefined;
  modelsDevModelFor: (
    provider: RuntimeProvider,
    modelId: string,
  ) => ReturnType<ModelsDevCatalog["findModel"]>;
  effectiveSubagentModelConfig: (
    provider: Pick<RuntimeProvider, "models">,
    modelId: string,
    catalogModelConfig: Parameters<typeof modelConfigWithBinding>[0],
  ) => {
    modelConfig: ReturnType<typeof modelConfigWithBinding>;
    capabilities: ReturnType<typeof capabilitiesFromModelConfig>;
  };
  normalizeThinkingLevel: (value: unknown) => ThinkingLevel;
};

export function createSessionLaunchRuntime({
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
  modelsDevModelFor,
  effectiveSubagentModelConfig,
  normalizeThinkingLevel,
}: SessionLaunchRuntimeDependencies) {
  const isHostUnavailable = (error: unknown): boolean =>
    (error as { errorCode?: string } | null | undefined)?.errorCode ===
    ErrorCodes.HOST_UNAVAILABLE;
  async function refreshUserMcp(
    projectPath: string | null | undefined = getWorkspacePath(),
  ): Promise<McpServerRecord[]> {
    // A dead transport is expected during shutdown and between supervised
    // restarts, and it rejects every call — warning about it would file the
    // routine case under the same log line as a registry that cannot be read.
    // The guard skips the calls that have not started; the catch covers the ones
    // already in flight when the transport closed.
    if (!runtimeState.host?.isAvailable()) return [];
    try {
      const result = await runtimeState.host!.call<{ servers: McpServerRecord[] }>("mcp.active", {
        projectPath: projectPath ?? null,
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
  
  /** The user's own skills, filtered to the ones a session on this project sees. */
  async function activeUserSkills(
    projectPath: string | undefined,
  ): Promise<UserSkillRecord[]> {
    if (!runtimeState.host?.isAvailable()) return [];
    try {
      const result = await runtimeState.host!.call<{ skills: UserSkillRecord[] }>("skills.active", {
        projectPath: projectPath ?? null,
      });
      return result.skills ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) {
        logger.app("plugin", "warn", "skills list failed", { data: String(error) });
      }
      return [];
    }
  }
  
  /**
   * The user's own subagent definitions, filtered to the ones a session on this
   * project sees, as documents the runtime can parse (D202).
   *
   * host-core owns the registry and the activation scope; the document text is
   * read here because this is where the other two definition sources are read
   * too, so all three reach `loadSubagentDefinitions` in the same shape.
   */
  async function activeUserSubagentDocuments(
    projectPath: string | undefined,
  ): Promise<UserSubagentDocument[]> {
    if (!runtimeState.host?.isAvailable()) return [];
    let records: UserSubagentRecord[] = [];
    try {
      const result = await runtimeState.host!.call<{ subagents: UserSubagentRecord[] }>(
        "agents.active",
        { projectPath: projectPath ?? null },
      );
      records = result.subagents ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) {
        logger.app("plugin", "warn", "subagent list failed", { data: String(error) });
      }
      return [];
    }
    const documents: UserSubagentDocument[] = [];
    const { readFile } = await import("node:fs/promises");
    for (const record of records) {
      try {
        documents.push({
          id: record.id,
          document: await readFile(record.path, "utf8"),
          filePath: record.path,
        });
      } catch (error) {
        // A document deleted behind the registry's back is one lost delegate,
        // never a lost turn.
        logger.app("plugin", "warn", "subagent document unreadable", {
          data: { id: record.id, error: String(error) },
        });
      }
    }
    return documents;
  }
  
  /**
   * Load one of the user's own skill documents by id, or `null` if there is no
   * such skill — so the caller can fall through to the plugin catalog.
   *
   * The scope check is repeated here rather than trusted from the catalog: a
   * session can outlive the prompt that listed the skill, and re-scoping a skill
   * mid-session should take effect immediately.
   */
  async function loadUserSkillBody(
    id: string,
    projectPath: string | null,
  ): Promise<{ id: string; name: string; body: string } | null> {
    if (!runtimeState.host || id.includes("/")) return null;
    const result = await runtimeState.host!.call<{
      skill: UserSkillRecord | null;
      body: string | null;
    }>("skills.read", { id, projectPath });
    const skill = result.skill;
    if (!skill || typeof result.body !== "string") return null;
    if (!isActiveInProject(skill, projectPath)) {
      throw new Error(`skill "${id}" is not enabled for this project`);
    }
    return { id: skill.id, name: skill.name, body: result.body };
  }
  
  async function resolveEffectiveCommandShell(): Promise<CommandShellCatalog> {
    if (!runtimeState.host) throw new Error("host unavailable");
    const catalog = await runtimeState.host!.call<CommandShellCatalog>("commandShells.list");
    if (!isCommandShellCatalog(catalog)) {
      throw Object.assign(new Error("Host returned an invalid command shell catalog"), {
        errorCode: ErrorCodes.COMMAND_SHELL_INVALID,
      });
    }
    if (!catalog.effective || !catalog.effective.available) {
      throw Object.assign(
        new Error("No available command shell is configured for this session"),
        { errorCode: ErrorCodes.SHELL_NOT_FOUND },
      );
    }
    return catalog;
  }
  
  async function resolveAgentRuntimeLaunch(
    sessionId: string,
    session: any,
    settings: any,
    overrides: {
      mode?: Mode;
      turnId?: string;
      providerId?: string;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
    } = {},
  ) {
    if (!runtimeState.host) throw new Error("host unavailable");
    await modelsDevCatalog.ensureLoaded();
    const commandShell = (await resolveEffectiveCommandShell()).effective!;
    const providers = await runtimeState.host!.call<{ providers: RuntimeProvider[] }>(
      "providers.list",
      { includeDisabled: false },
    );
    const requestedProviderId = overrides.providerId ?? session.providerId;
    const provider =
      providers.providers.find((item) => item.id === requestedProviderId) ||
      providers.providers.find((item) => item.id === settings.defaultProviderId) ||
      providers.providers.find(
        (item) => item.hasSecret || item.hasOauth || item.authKind === "none",
      ) ||
      providers.providers[0];
    if (!provider) {
      throw Object.assign(new Error("No provider configured"), {
        errorCode: ErrorCodes.MODEL_NOT_CONFIGURED,
      });
    }
    // A vendor account has no long-lived key to read: the sidecar asks main for
    // short-lived request auth instead (see `provider.resolveAuth`), so the
    // launch payload deliberately carries no credential at all.
    const isVendorAccount = provider.authKind === OAUTH_AUTH_KIND;
    const secret = isVendorAccount
      ? { value: undefined }
      : await runtimeState.host!.call<{ value?: string }>("providers.getSecret", {
          id: provider.id,
        });
    if (!secret.value && !isVendorAccount && provider.authKind !== "none") {
      throw Object.assign(new Error("Provider API key missing"), {
        errorCode: ErrorCodes.PROVIDER_SECRET_MISSING,
      });
    }
    const modelId =
      (provider.id === requestedProviderId
        ? overrides.modelId ?? session.modelId
        : undefined) ||
      (provider.id === settings.defaultProviderId
        ? settings.defaultModelId
        : undefined) ||
      provider.models?.[0]?.id ||
      provider.defaultModelId;
    if (!modelId) {
      throw Object.assign(new Error("No model selected for provider"), {
        errorCode: ErrorCodes.MODEL_NOT_CONFIGURED,
      });
    }
    // The authenticated collection owns a vendor account's available model IDs
    // and wire endpoint. models.dev owns metadata; one account can span multiple
    // wire APIs and gateway catalogs.
    const vendorBinding = isVendorAccount
      ? await vendorOAuth
          .bindingFor(provider.id, modelId)
          .catch(() => undefined)
      : undefined;
    if (isVendorAccount && !vendorBinding) {
      throw Object.assign(
        new Error(`Vendor account does not offer model "${modelId}"`),
        { errorCode: ErrorCodes.MODEL_NOT_CONFIGURED },
      );
    }
    const storedModel = bindingForModel(provider, modelId);
    const apiStyle = vendorBinding?.apiStyle ?? provider.apiStyle;
    const baseUrl = vendorBinding?.baseUrl ?? provider.baseUrl;
    const modelsDevModel = modelsDevModelFor(provider, modelId);
    const catalogModelConfig = vendorBinding?.modelConfig ??
      (modelsDevModel
        ? modelConfigFromModelsDev(modelsDevModel, baseUrl)
        : genericModelConfig(modelId, baseUrl ?? ""));
    const modelConfig = modelConfigWithBinding(catalogModelConfig, storedModel);
    const thinkingCapabilities = capabilitiesFromModelConfig(modelConfig);
    const thinkingLevel = clampThinkingLevel(
      thinkingCapabilities,
      normalizeThinkingLevel(
        overrides.thinkingLevel ??
          (provider.id === requestedProviderId ? session.thinkingLevel : undefined) ??
          storedModel?.defaultThinkingLevel,
      ),
    );
    const projectPath =
      typeof session.projectPath === "string" && session.projectPath.trim()
        ? session.projectPath.trim()
        : undefined;
    const projectInstructions = await loadInstructionChain(projectPath);
    sessionProjects.set(sessionId, projectPath ?? null);
    // Everything below is filtered by activation scope: a plugin, MCP server or
    // skill limited to certain projects must be invisible to a session on any
    // other one — not merely refused when called, since a tool the model can see
    // is a tool it will try.
    const userSkills = await activeUserSkills(projectPath);
    await refreshUserMcp(projectPath);
    const userMcpTools = await userMcp.toolsForProject(projectPath ?? null);
    // Skill catalog (D174): only id/name/description cross to the sidecar; the
    // document body is fetched on demand through the local `Skill` tool. Host
    // skills come first so a plugin's entry reads as a refinement of them, and
    // the user's own skills come last so they win a name clash in the model's
    // reading order.
    const pluginSkills = [
      ...builtinSkills({
        workspacePath: projectPath,
        pluginPaths: plugins.listLoaded().map((loaded) => loaded.path),
      }),
      ...plugins
        .getSkills()
        .filter((skill) => pluginActiveInProject(skill.pluginId, projectPath))
        .map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
        })),
      ...userSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
      })),
    ];
    // Subagents (ADR 0062): definitions are re-read per launch so editing
    // `~/.agents/subagents` or the registry takes effect on the next prompt, and every
    // pinned model is resolved here because credentials and the models.dev catalog
    // live on this side. The user's own definitions (D202) are scope-filtered like the
    // skills above; a delegate the model can see is one it will try to call.
    const subagentCatalog = await loadSubagentDefinitions(projectPath, {
      userDocuments: await activeUserSubagentDocuments(projectPath),
    });
    const subagentBindings = await resolveSubagentProviders({
      definitions: subagentCatalog.definitions,
      providers: providers.providers,
      getSecret: async (id: string) =>
        (await runtimeState.host!.call<{ value?: string }>("providers.getSecret", { id })).value,
      resolveVendorBinding: (pinned, pinnedModelId) =>
        vendorOAuth.bindingFor(pinned.id, pinnedModelId),
      resolveModel: async (pinned, pinnedModelId) => {
        const model = modelsDevCatalog.findModel({
          vendorKey: pinned.vendorKey,
          baseUrl: pinned.baseUrl,
          modelId: pinnedModelId,
        });
        const catalogModelConfig = model
          ? modelConfigFromModelsDev(model, pinned.baseUrl)
          : genericModelConfig(pinnedModelId, pinned.baseUrl ?? "");
        const configuredProvider = providers.providers.find(
          (candidate) => candidate.id === pinned.id,
        );
        return configuredProvider
          ? effectiveSubagentModelConfig(
              configuredProvider,
              pinnedModelId,
              catalogModelConfig,
            )
          : {
              modelConfig: catalogModelConfig,
              capabilities: capabilitiesFromModelConfig(catalogModelConfig),
            };
      },
    });
    // Delegation model catalog: every model binding flagged
    // `availableForSubagents` is pre-resolved so the system prompt can list
    // them and the parent agent can pass them to `Task.model` without an
    // extra RPC round-trip. Statically pinned entries from definitions take
    // precedence — they were resolved above with stricter diagnostics.
    for (const row of providers.providers) {
      if (!row.enabled) continue;
      for (const binding of row.models ?? []) {
        if (!binding.availableForSubagents) continue;
        const key = `${row.vendorKey ?? row.name}/${binding.id}`;
        if (subagentBindings.providers[key]) continue; // already pinned
        const isVendorAccount = row.authKind === OAUTH_AUTH_KIND;
        let apiKey = "";
        if (!isVendorAccount && row.authKind !== "none") {
          try {
            apiKey =
              (
                await runtimeState.host!.call<{ value?: string }>("providers.getSecret", {
                  id: row.id,
                })
              ).value ?? "";
          } catch {
            continue; // skip if secret unavailable
          }
          if (!apiKey) continue;
        }
        let catalogModelConfig: Parameters<typeof modelConfigWithBinding>[0];
        if (isVendorAccount) {
          const vb = await vendorOAuth.bindingFor(row.id, binding.id);
          if (!vb) continue;
          catalogModelConfig =
            vb.modelConfig ?? genericModelConfig(binding.id, vb.baseUrl ?? row.baseUrl ?? "");
        } else {
          const model = modelsDevCatalog.findModel({
            vendorKey: row.vendorKey,
            baseUrl: row.baseUrl,
            modelId: binding.id,
          });
          catalogModelConfig = model
            ? modelConfigFromModelsDev(model, row.baseUrl)
            : genericModelConfig(binding.id, row.baseUrl ?? "");
        }
        const effective = effectiveSubagentModelConfig(
          row,
          binding.id,
          catalogModelConfig,
        );
        const mc = effective.modelConfig;
        const caps = effective.capabilities;
        subagentBindings.providers[key] = {
          id: row.id,
          name: row.name,
          ...(row.vendorKey ? { vendorKey: row.vendorKey } : {}),
          ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
          modelId: binding.id,
          apiKey,
          ...(row.authKind ? { authKind: row.authKind } : {}),
          ...(row.apiStyle ? { apiStyle: row.apiStyle } : {}),
          ...optionalProviderHeaders(row.headers),
          supportsReasoning: caps.supportsReasoning,
          supportedThinkingLevels: [...caps.supportedThinkingLevels],
          ...(mc ? { modelConfig: mc } : {}),
        };
      }
    }
  
    const subagentDiagnostics = [
      ...subagentCatalog.diagnostics,
      ...subagentBindings.diagnostics,
    ];
    if (subagentDiagnostics.length > 0) {
      logger.app("session", "warn", "subagent definitions have problems", {
        sessionId,
        data: { diagnostics: subagentDiagnostics },
      });
    }
    // Bind the vendor-account rows this turn is allowed to sign requests with:
    // the session's own provider plus any row a pinned subagent resolved to. The
    // sidecar may then ask main for request auth, but only for a row named here,
    // and the set is rewritten on every launch.
    runtimeState.sidecar?.setVendorAuthBindings(
      sessionId,
      [
        provider.id,
        ...Object.values(subagentBindings.providers).map((binding) => binding.id),
      ]
        .map((id) => providers.providers.find((row) => row.id === id))
        .flatMap((row) =>
          row?.authKind === OAUTH_AUTH_KIND
            ? [{ providerId: row.id }]
            : [],
        ),
    );
    return {
      providerId: provider.id,
      modelId,
      projectPath,
      sidecarParams: {
        sessionId,
        mode: normalizeMode(
          overrides.mode ?? session.mode ?? settings.defaultMode ?? "agent",
        ),
        ...(overrides.turnId ? { turnId: overrides.turnId } : {}),
        thinkingLevel,
        commandShell,
        scratchDir: join(dataDir, "scratch", sessionId),
        attachmentsDir: join(dataDir, "attachments"),
        projectPath,
        projectInstructions,
        provider: {
          id: provider.id,
          name: provider.name,
          vendorKey: provider.vendorKey,
          baseUrl,
          modelId,
          apiKey: secret.value || "",
          authKind: provider.authKind,
          apiStyle,
          ...optionalProviderHeaders(provider.headers),
          supportsReasoning: thinkingCapabilities.supportsReasoning,
          supportsVision: visionFromModelConfig(modelConfig),
          supportedThinkingLevels: [...thinkingCapabilities.supportedThinkingLevels],
          ...(modelConfig ? { modelConfig } : {}),
        },
        pluginTools: [
          ...plugins
            .getTools()
            .filter((tool) => pluginActiveInProject(tool.pluginId, projectPath))
            .map((tool) => ({
              name: tool.fullName,
              description: tool.description,
              parameters: tool.schema ?? { type: "object", properties: {} },
              ...(tool.risk === "low" || tool.risk === "medium" || tool.risk === "high"
                ? { risk: tool.risk as Risk }
                : {}),
              // Plan-safe action list is forwarded to host-core so it can
              // admit the tool in Plan/Goal modes (ADR 0211).
              ...(tool.planSafeActions && tool.planSafeActions.length > 0
                ? { planSafeActions: tool.planSafeActions }
                : {}),
            })),
          ...userMcpTools.map((tool) => ({
            name: tool.fullName,
            description: tool.description,
            parameters: tool.schema ?? { type: "object", properties: {} },
          })),
        ],
        // Plugin skills (D174): only the catalog crosses to the sidecar; the
        // document body is fetched on demand through the local `Skill` tool.
        pluginSkills,
        // Trusted extensions enabled for this project (spec 16 §3.2). The set
        // is part of the runtime match, so a toggle retires the runtime.
        trustedExtensions: plugins
          .getAgentExtensions()
          .filter((extension) => pluginActiveInProject(extension.pluginId, projectPath))
          .map((extension) => ({
            id: extension.id,
            entry: extension.entry,
            label: extension.pluginName,
            source: "plugin" as const,
            root: extension.root,
          })),
        subagents: subagentCatalog.definitions,
        subagentProviders: subagentBindings.providers,
      },
    };
  }
  
  return {
    refreshUserMcp,
    activeUserSkills,
    activeUserSubagentDocuments,
    loadUserSkillBody,
    resolveEffectiveCommandShell,
    resolveAgentRuntimeLaunch,
  };
}
