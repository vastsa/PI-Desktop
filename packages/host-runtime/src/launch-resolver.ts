import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ErrorCodes,
  OAUTH_AUTH_KIND,
  isActiveInProject,
  isCommandShellCatalog,
  normalizeMode,
  resolveBindingContextWindow,
  trustedExtensionAgentKeyFromProviderId,
  type CommandShellCatalog,
  type ModelBinding,
  type Mode,
  type SessionThinkingLevel,
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
  type RuntimeProviderConfig,
  type UserSubagentDocument,
} from "@pi-desktop/agent-runtime";

import type { HostRpc } from "./host-ports.js";

/** A provider row as `providers.list` returns it. */
export type HostProviderRecord = {
  id: string;
  name: string;
  vendorKey?: string;
  baseUrl?: string;
  modelId?: string;
  models?: ModelBinding[];
  defaultModelId?: string;
  authKind?: string;
  apiStyle?: string;
  hasSecret?: boolean;
  hasOauth?: boolean;
  headers?: Record<string, string>;
  enabled?: boolean;
};

export type LaunchOverrides = {
  mode?: Mode;
  turnId?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: SessionThinkingLevel;
};

/** What a turn needs to start: the provider identity and the sidecar payload. */
export type ResolvedLaunch = {
  providerId: string;
  modelId: string;
  projectPath?: string;
  sidecarParams: Record<string, unknown> & {
    sessionId: string;
    mode: Mode;
    provider: RuntimeProviderConfig & { supportsVision?: boolean };
  };
};

export interface LaunchResolver {
  resolve(
    sessionId: string,
    session: Record<string, unknown>,
    settings: Record<string, unknown>,
    overrides?: LaunchOverrides,
  ): Promise<ResolvedLaunch>;
}

export type ModelCatalogPort = {
  /** Catalog metadata for a provider model, or `undefined` for a generic shape. */
  modelConfig(
    provider: Pick<HostProviderRecord, "vendorKey" | "baseUrl">,
    modelId: string,
  ): ReturnType<typeof genericModelConfig> | undefined;
};

export type HeadlessLaunchResolverOptions = {
  getHost: () => HostRpc | null;
  dataDir: string;
  log: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
  /** Optional models.dev snapshot; without it every model runs on the generic transport shape. */
  catalog?: ModelCatalogPort;
};

const SESSION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "omit"] as const;

function normalizeThinkingLevel(value: unknown): SessionThinkingLevel {
  return typeof value === "string" &&
    (SESSION_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as SessionThinkingLevel)
    : "off";
}

function launchError(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

function isHostUnavailable(error: unknown): boolean {
  return (error as { errorCode?: string } | null)?.errorCode === ErrorCodes.HOST_UNAVAILABLE;
}

/**
 * Launch resolution for a headless Host. It is the desktop's
 * `resolveAgentRuntimeLaunch` minus the surfaces a headless machine does not
 * have: no plugin tools, no user MCP relay, no plugin agents, no vendor OAuth
 * accounts. Everything else — provider rows and secrets, the effective
 * command shell, project instructions and memory, the user's skills and
 * subagent definitions — comes from the same host-core registries.
 */
export function createHeadlessLaunchResolver(options: HeadlessLaunchResolverOptions): LaunchResolver {
  const { getHost, dataDir, log } = options;

  function requireHost(): HostRpc {
    const host = getHost();
    if (!host) throw launchError("host unavailable", ErrorCodes.HOST_UNAVAILABLE);
    return host;
  }

  async function activeUserSkills(projectPath: string | undefined): Promise<UserSkillRecord[]> {
    try {
      const result = await requireHost().call<{ skills: UserSkillRecord[] }>("skills.active", {
        projectPath: projectPath ?? null,
      });
      return result.skills ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) log("warn", "skills list failed", { error: String(error) });
      return [];
    }
  }

  async function activeUserSubagentDocuments(projectPath: string | undefined): Promise<UserSubagentDocument[]> {
    let records: UserSubagentRecord[] = [];
    try {
      const result = await requireHost().call<{ subagents: UserSubagentRecord[] }>("agents.active", {
        projectPath: projectPath ?? null,
      });
      records = result.subagents ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) log("warn", "subagent list failed", { error: String(error) });
      return [];
    }
    const documents: UserSubagentDocument[] = [];
    for (const record of records) {
      try {
        documents.push({ id: record.id, document: await readFile(record.path, "utf8"), filePath: record.path });
      } catch (error) {
        log("warn", "subagent document unreadable", { id: record.id, error: String(error) });
      }
    }
    return documents;
  }

  async function disabledBuiltinSubagents(): Promise<string[]> {
    try {
      const result = await requireHost().call<{ disabled: string[] }>("agents.disabledBuiltins");
      return result.disabled ?? [];
    } catch (error) {
      if (!isHostUnavailable(error)) log("warn", "builtin subagent state failed", { error: String(error) });
      return [];
    }
  }

  async function resolveEffectiveCommandShell(): Promise<CommandShellCatalog> {
    const catalog = await requireHost().call<CommandShellCatalog>("commandShells.list");
    if (!isCommandShellCatalog(catalog)) {
      throw launchError("Host returned an invalid command shell catalog", "COMMAND_SHELL_INVALID");
    }
    if (!catalog.effective || !catalog.effective.available) {
      throw launchError("No available command shell is configured for this session", "SHELL_NOT_FOUND");
    }
    return catalog;
  }

  function catalogModelConfig(provider: HostProviderRecord, modelId: string, baseUrl: string | undefined) {
    return options.catalog?.modelConfig({ vendorKey: provider.vendorKey, baseUrl }, modelId)
      ?? genericModelConfig(modelId, baseUrl ?? "");
  }

  function bindingForModel(provider: Pick<HostProviderRecord, "models">, modelId: string): ModelBinding | undefined {
    return provider.models?.find((binding) => binding.id === modelId);
  }

  function effectiveModelConfig(provider: HostProviderRecord, modelId: string, baseUrl: string | undefined) {
    const storedModel = bindingForModel(provider, modelId);
    const resolvedLimits = resolveBindingContextWindow(catalogModelConfig(provider, modelId, baseUrl), storedModel);
    const modelConfig = modelConfigWithBinding(resolvedLimits.catalogConfig, resolvedLimits.binding);
    return { modelConfig, capabilities: capabilitiesFromModelConfig(modelConfig), storedModel };
  }

  async function getSecret(providerId: string): Promise<string | undefined> {
    const secret = await requireHost().call<{ value?: string }>("providers.getSecret", { id: providerId });
    return secret?.value;
  }

  async function resolve(
    sessionId: string,
    session: Record<string, unknown>,
    settings: Record<string, unknown>,
    overrides: LaunchOverrides = {},
  ): Promise<ResolvedLaunch> {
    const host = requireHost();
    const commandShell = (await resolveEffectiveCommandShell()).effective!;
    const providers = await host.call<{ providers: HostProviderRecord[] }>("providers.list", {
      includeDisabled: false,
    });
    const sessionProviderId = typeof session.providerId === "string" ? session.providerId : undefined;
    const sessionModelId = typeof session.modelId === "string" ? session.modelId : undefined;
    const requestedProviderId = overrides.providerId ?? sessionProviderId;
    if (requestedProviderId && trustedExtensionAgentKeyFromProviderId(requestedProviderId)) {
      throw launchError("Plugin agents are not available on a headless host", ErrorCodes.MODEL_NOT_CONFIGURED);
    }
    const defaultProviderId = typeof settings.defaultProviderId === "string" ? settings.defaultProviderId : undefined;
    const defaultModelId = typeof settings.defaultModelId === "string" ? settings.defaultModelId : undefined;
    const provider =
      providers.providers.find((item) => item.id === requestedProviderId) ||
      providers.providers.find((item) => item.id === defaultProviderId) ||
      providers.providers.find((item) => item.hasSecret || item.authKind === "none") ||
      providers.providers[0];
    if (!provider) throw launchError("No provider configured", ErrorCodes.MODEL_NOT_CONFIGURED);
    if (provider.authKind === OAUTH_AUTH_KIND) {
      throw launchError(
        "Vendor account sign-in is not available on a headless host; configure an API key provider",
        ErrorCodes.MODEL_NOT_CONFIGURED,
      );
    }
    const secretValue = provider.authKind === "none" ? undefined : await getSecret(provider.id);
    if (!secretValue && provider.authKind !== "none") {
      throw launchError("Provider API key missing", ErrorCodes.PROVIDER_SECRET_MISSING);
    }
    const modelId =
      (provider.id === requestedProviderId ? overrides.modelId ?? sessionModelId : undefined) ||
      (provider.id === defaultProviderId ? defaultModelId : undefined) ||
      provider.models?.[0]?.id ||
      provider.defaultModelId;
    if (!modelId) throw launchError("No model selected for provider", ErrorCodes.MODEL_NOT_CONFIGURED);

    const { modelConfig, capabilities, storedModel } = effectiveModelConfig(provider, modelId, provider.baseUrl);
    const thinkingLevel = clampThinkingLevel(
      capabilities,
      normalizeThinkingLevel(
        overrides.thinkingLevel ??
          (provider.id === requestedProviderId ? session.thinkingLevel : undefined) ??
          storedModel?.defaultThinkingLevel,
      ),
    );
    const projectPath =
      typeof session.projectPath === "string" && session.projectPath.trim() ? session.projectPath.trim() : undefined;
    let projectInstructions = await loadInstructionChain(projectPath);
    let projectMemory: string | undefined;
    if (projectPath) {
      try {
        const result = await host.call<{
          context?: { roots?: Array<{ path?: string }>; instructions?: string; memory?: { content?: string } } | null;
        }>("project.group.context", { path: projectPath });
        const groupRoots = result.context?.roots ?? [];
        const groupRootGuide =
          groupRoots.length > 1
            ? [
                `Primary root: ${groupRoots[0]?.path ?? projectPath}`,
                ...groupRoots.slice(1).map((root) => `Additional root: ${root.path}`),
                "Use an absolute path when reading or editing an additional root.",
              ].join("\n")
            : "";
        const groupInstructions = result.context?.instructions?.trim();
        if (groupRootGuide || groupInstructions) {
          projectInstructions = {
            entries: [
              ...(projectInstructions?.entries ?? []),
              ...(groupRootGuide ? [{ source: "ChatGPT Project folders", content: groupRootGuide }] : []),
              ...(groupInstructions ? [{ source: "ChatGPT Project instructions", content: groupInstructions }] : []),
            ],
          };
        }
        const groupMemory = result.context?.memory?.content?.trim();
        if (groupMemory) projectMemory = groupMemory;
        if (!result.context) {
          const legacy = await host.call<{ memory?: { content?: string } }>("project.memory.get", { path: projectPath });
          const content = legacy.memory?.content?.trim();
          if (content) projectMemory = content;
        }
      } catch {
        try {
          const legacy = await host.call<{ memory?: { content?: string } }>("project.memory.get", { path: projectPath });
          const content = legacy.memory?.content?.trim();
          if (content) projectMemory = content;
        } catch {
          // Project memory is best effort; it must never prevent a session launch.
        }
      }
    }

    const userSkills = (await activeUserSkills(projectPath)).filter((skill) => isActiveInProject(skill, projectPath ?? null));
    const pluginSkills = userSkills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description }));

    const subagentCatalog = await loadSubagentDefinitions(projectPath, {
      userDocuments: await activeUserSubagentDocuments(projectPath),
      disabledBuiltins: await disabledBuiltinSubagents(),
    });
    const subagentBindings = await resolveSubagentProviders({
      definitions: subagentCatalog.definitions,
      providers: providers.providers,
      getSecret,
      resolveModel: async (pinned, pinnedModelId) => {
        const row = providers.providers.find((candidate) => candidate.id === pinned.id);
        const resolved = effectiveModelConfig(row ?? { ...pinned, models: [] }, pinnedModelId, pinned.baseUrl);
        return { modelConfig: resolved.modelConfig, capabilities: resolved.capabilities };
      },
    });
    const subagentModelKeys: string[] = [];
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
        if (row.authKind === OAUTH_AUTH_KIND) continue;
        let apiKey = "";
        if (row.authKind !== "none") {
          try {
            apiKey = (await getSecret(row.id)) ?? "";
          } catch {
            continue;
          }
          if (!apiKey) continue;
        }
        const effective = effectiveModelConfig(row, binding.id, row.baseUrl);
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
          supportsReasoning: effective.capabilities.supportsReasoning,
          supportedThinkingLevels: [...effective.capabilities.supportedThinkingLevels],
          modelConfig: effective.modelConfig,
        };
        subagentModelKeys.push(key);
      }
    }
    const subagentDiagnostics = [...subagentCatalog.diagnostics, ...subagentBindings.diagnostics];
    if (subagentDiagnostics.length > 0) {
      log("warn", "subagent definitions have problems", { sessionId, diagnostics: subagentDiagnostics });
    }

    const sessionMode = typeof session.mode === "string" ? session.mode : undefined;
    const defaultMode = typeof settings.defaultMode === "string" ? settings.defaultMode : undefined;
    return {
      providerId: provider.id,
      modelId,
      projectPath,
      sidecarParams: {
        sessionId,
        mode: normalizeMode(overrides.mode ?? sessionMode ?? defaultMode ?? "agent"),
        ...(overrides.turnId ? { turnId: overrides.turnId } : {}),
        thinkingLevel,
        commandShell,
        scratchDir: join(dataDir, "scratch", sessionId),
        attachmentsDir: join(dataDir, "attachments"),
        projectPath,
        projectInstructions,
        projectMemory,
        provider: {
          id: provider.id,
          name: provider.name,
          vendorKey: provider.vendorKey,
          baseUrl: provider.baseUrl,
          modelId,
          apiKey: secretValue || "",
          authKind: provider.authKind,
          apiStyle: provider.apiStyle,
          ...optionalProviderHeaders(provider.headers),
          supportsReasoning: capabilities.supportsReasoning,
          supportsVision: visionFromModelConfig(modelConfig),
          supportedThinkingLevels: [...capabilities.supportedThinkingLevels],
          modelConfig,
        },
        pluginTools: [],
        pluginSkills,
        trustedExtensions: [],
        subagents: subagentCatalog.definitions,
        subagentProviders: subagentBindings.providers,
        subagentModelKeys,
      },
    };
  }

  return { resolve };
}
