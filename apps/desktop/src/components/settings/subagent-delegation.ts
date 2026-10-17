/**
 * The Models page's subagent-delegation list.
 *
 * `ModelBinding.availableForSubagents` is the only source of truth for the
 * delegation catalog: the runtime builds that catalog from it at launch
 * (`packages/host-runtime/src/launch-resolver.ts`) and authorizes every
 * `Task.model` override against the same catalog. This page therefore edits
 * those flags themselves — one list across every configured service — instead
 * of keeping a second selection the runtime would have to merge, so what the
 * page shows is exactly what the AI may pick.
 *
 * The helpers stay free of runtime imports so the catalog rules can be tested
 * without the application bundle.
 */
import type { ModelBinding, ProviderPublic } from "@pi-desktop/shared";

/** Why an opted-in model cannot reach the catalog today. */
export type SubagentModelBlockedReason = "provider-disabled" | "credential-missing";

/** One configured model, with the delegation state the page renders. */
export type SubagentModelCandidate = {
  providerId: string;
  providerName: string;
  modelId: string;
  /** The alias the rest of Settings shows, else the wire id. */
  label: string;
  /** True when this binding carries the delegation opt-in. */
  selected: boolean;
  /**
   * False only when a plugin owns the service row: the plugin refreshes it on
   * every load and `providers.update` refuses it. A service that is merely off
   * stays editable so its opt-in can be prepared before it is switched on.
   */
  editable: boolean;
  /** Set when the opt-in exists but the service cannot serve it yet. */
  blocked?: SubagentModelBlockedReason;
};

export type SubagentModelGroup = {
  providerId: string;
  providerName: string;
  candidates: SubagentModelCandidate[];
};

/** The provider facts the delegation rules read; anything else is ignored. */
export type SubagentProviderFacts = {
  enabled: boolean;
  hasSecret?: boolean;
  hasOauth?: boolean;
  authKind?: string;
};

/**
 * Whether this service can serve a delegated run at all.
 *
 * Same rule the subagent editor's own model picker applies to the Composer's
 * runnable services: the row must be enabled and hold a usable credential (an
 * API key, a vendor-account login, or a keyless local endpoint).
 */
export function providerServesSubagentDelegation(provider: SubagentProviderFacts): boolean {
  return (
    provider.enabled &&
    (provider.hasSecret === true ||
      provider.hasOauth === true ||
      provider.authKind === "none")
  );
}

function blockedReason(provider: SubagentProviderFacts): SubagentModelBlockedReason | undefined {
  if (!provider.enabled) return "provider-disabled";
  return providerServesSubagentDelegation(provider) ? undefined : "credential-missing";
}

function candidateKey(providerId: string, modelId: string): string {
  // Wire ids travel the request path, so identity is case-insensitive here the
  // same way `sameWireId` treats them elsewhere in Settings.
  return `${providerId}\u0000${modelId.trim().toLowerCase()}`;
}

function modelLabel(binding: ModelBinding): string {
  const alias = binding.alias?.trim();
  return alias && alias.length > 0 ? alias : binding.id;
}

/**
 * Every configured model, in service order, with its delegation state.
 *
 * A model is listed even when its service is off or missing a credential: the
 * flag is a durable choice, and hiding it would leave an opt-in the user cannot
 * see or withdraw.
 */
export function subagentModelCandidates(
  providers: readonly ProviderPublic[],
): SubagentModelCandidate[] {
  const candidates: SubagentModelCandidate[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    const blocked = blockedReason(provider);
    for (const binding of provider.models ?? []) {
      const modelId = binding.id.trim();
      if (!modelId) continue;
      const key = candidateKey(provider.id, modelId);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId,
        label: modelLabel(binding),
        selected: binding.availableForSubagents === true,
        editable: !provider.ownerPluginId,
        ...(blocked ? { blocked } : {}),
      });
    }
  }
  return candidates;
}

/** The opted-in rows, which are the delegation catalog's own membership. */
export function selectedSubagentModels(
  candidates: readonly SubagentModelCandidate[],
): SubagentModelCandidate[] {
  return candidates.filter((candidate) => candidate.selected);
}

/** Group in service order so one service's models read as one block. */
export function groupSubagentModels(
  candidates: readonly SubagentModelCandidate[],
): SubagentModelGroup[] {
  const groups: SubagentModelGroup[] = [];
  for (const candidate of candidates) {
    const last = groups[groups.length - 1];
    if (last && last.providerId === candidate.providerId) last.candidates.push(candidate);
    else {
      groups.push({
        providerId: candidate.providerId,
        providerName: candidate.providerName,
        candidates: [candidate],
      });
    }
  }
  return groups;
}

/**
 * The service's bindings with one delegation opt-in changed.
 *
 * A cleared opt-in drops the key instead of storing `false`, matching the
 * provider dialog: the field is absent on every binding that never wanted
 * delegation, and `availableForSubagents: false` never accumulates on records.
 * Every other field is carried over untouched, because the RPC replaces the
 * whole model list.
 */
export function subagentModelOptInDraft(
  models: readonly ModelBinding[],
  modelId: string,
  selected: boolean,
): ModelBinding[] {
  const target = modelId.trim().toLowerCase();
  return models.map((model) =>
    model.id.trim().toLowerCase() === target
      ? { ...model, availableForSubagents: selected ? true : undefined }
      : model,
  );
}
