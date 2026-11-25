import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { SUBAGENT_THINKING_LEVELS, subagentModelKey, type SubagentDefinition, type SubagentThinkingLevel } from "@pi-desktop/shared";
import { isRecord } from "./agent-messages.js";
import { isScopeConstrainableTool, parseWriteScope, sameWriteScope, scopeSafeToolNames } from "./delegation-scope.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { clampThinkingLevel } from "./thinking-level.js";

/** Transcript metadata, not a grant. No provider credentials or role prompt. */
export type DelegationPolicy = {
  mode: string;
  roleHash: string;
  toolNames: string[];
  writeScope?: string[];
  inheritedThinkingLevel?: SubagentThinkingLevel;
  workspaceHash: string;
  toolHash: string;
};

export type DelegationModelSelection = {
  source: "pin" | "session" | "override";
  key: string;
  providerId: string;
  modelId: string;
};

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => isRecord(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
    : entry);
}

export function delegationPolicyHash(value: unknown): string {
  return createHash("sha256").update(sortedJson(value)).digest("hex");
}

export function readDelegationPolicy(value: unknown): DelegationPolicy | undefined {
  if (!isRecord(value) || typeof value.mode !== "string" ||
      typeof value.roleHash !== "string" || !/^[a-f0-9]{64}$/.test(value.roleHash) ||
      typeof value.workspaceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.workspaceHash) ||
      typeof value.toolHash !== "string" || !/^[a-f0-9]{64}$/.test(value.toolHash) ||
      !Array.isArray(value.toolNames) || !value.toolNames.every((name): name is string => typeof name === "string")) return undefined;
  const scope = parseWriteScope(value.writeScope === undefined ? undefined : { write: value.writeScope });
  if (scope.kind === "invalid") return undefined;
  const inheritedThinkingLevel = SUBAGENT_THINKING_LEVELS.find((level) => level === value.inheritedThinkingLevel);
  if (value.inheritedThinkingLevel !== undefined && inheritedThinkingLevel === undefined) return undefined;
  return {
    mode: value.mode, roleHash: value.roleHash, workspaceHash: value.workspaceHash,
    toolHash: value.toolHash, toolNames: [...value.toolNames],
    ...(scope.kind === "scoped" ? { writeScope: scope.entries } : {}),
    ...(inheritedThinkingLevel ? { inheritedThinkingLevel } : {}),
  };
}

export function readDelegationModel(value: unknown): DelegationModelSelection | undefined {
  if (!isRecord(value) || (value.source !== "pin" && value.source !== "session" && value.source !== "override") ||
      typeof value.key !== "string" || typeof value.providerId !== "string" || typeof value.modelId !== "string") return undefined;
  return { source: value.source, key: value.key, providerId: value.providerId, modelId: value.modelId };
}

export function delegationModelSelection(source: DelegationModelSelection["source"], key: string, provider: RuntimeProviderConfig): DelegationModelSelection {
  return { source, key, providerId: provider.id, modelId: provider.modelId };
}

export function matchesDelegationModel(provider: RuntimeProviderConfig | undefined, model: DelegationModelSelection): provider is RuntimeProviderConfig {
  return provider?.id === model.providerId && provider.modelId === model.modelId;
}

/** A resume cannot exchange a role, mode or tool allowlist. The Host also
 * applies the current session permissions to every actual tool call. */
export function canResumeDelegation(prior: DelegationPolicy, next: DelegationPolicy): boolean {
  return prior.mode === next.mode && prior.roleHash === next.roleHash &&
    prior.workspaceHash === next.workspaceHash && prior.toolHash === next.toolHash &&
    isDeepStrictEqual(prior.toolNames, next.toolNames) && sameWriteScope(prior.writeScope, next.writeScope);
}

export function selectDelegationTools(options: {
  names: readonly string[];
  catalog: ReadonlyMap<string, AgentTool>;
  builtins: WeakSet<AgentTool>;
  writeScope?: readonly string[];
  scopedWritesSupported: boolean;
}): { tools: AgentTool[]; withheld: string[] } {
  const { names, catalog, builtins, writeScope } = options;
  const { kept, withheld } = scopeSafeToolNames(names, writeScope);
  const tools: AgentTool[] = [];
  for (const name of kept) {
    const tool = catalog.get(name);
    if (!tool) continue;
    if (writeScope && isScopeConstrainableTool(name) && !options.scopedWritesSupported) { withheld.push(name); continue; }
    if (writeScope && !builtins.has(tool)) withheld.push(name);
    else tools.push(tool);
  }
  return { tools, withheld };
}

export function thinkingForDelegationModel(input: {
  role: SubagentDefinition;
  provider: RuntimeProviderConfig;
  model: DelegationModelSelection;
  inherited: SubagentThinkingLevel;
}): SubagentThinkingLevel {
  const { role, provider, model, inherited } = input;
  const pin = model.source === "pin"
    ? [role.model, ...(role.fallbackModels ?? [])].find((candidate) => candidate && subagentModelKey(candidate) === model.key)
    : undefined;
  const requested = pin?.thinkingLevel ?? role.thinkingLevel ?? inherited;
  return requested === "omit" ? requested : clampThinkingLevel(provider, requested);
}

export function scopedWriteMetadata(toolName: string, writeScope: readonly string[] | undefined): { writeScope?: readonly string[] } {
  return writeScope && isScopeConstrainableTool(toolName) ? { writeScope } : {};
}