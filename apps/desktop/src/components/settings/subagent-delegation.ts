/**
 * The Models page's subagent-delegation list.
 *
 * `ModelBinding.availableForSubagents` is the only source of truth for the
 * delegation catalog: the runtime builds that catalog from it at launch
 * (`packages/host-runtime/src/launch-resolver.ts`) and authorizes every
 * `Task.model` override against the same catalog. This list therefore reads and
 * clears that flag on the binding itself — the same field a service's model
 * editor writes — so the page and the catalog cannot disagree, and a change made
 * in either place is visible in both.
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
  /** The binding's limits, shown the way a service's model list shows them. */
  contextWindow: number;
  maxTokens: number;
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

/**
 * Why an opt-in cannot reach the catalog yet.
 *
 * The rule is credential *presence*, not auth-kind identity: `hasSecret` is the
 * host's own "this row holds a usable credential" flag (an API key or a vendor
 * account), so an auth flow added later still counts here without teaching this
 * page about it. Only the keyless local endpoint is named explicitly, because
 * that is the one case where no credential is expected — which is why a row that
 * reports no credential at all really is unusable, rather than a guess at why.
 */
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
        contextWindow: binding.contextWindow,
        maxTokens: binding.maxTokens,
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

/** How many chips fit on one line, and how many collapse into `+N`. */
export type ChipFit = { visible: number; hidden: number };

/**
 * Fit chips into a bounded line, reserving room for the `+N` chip when not
 * everything fits.
 *
 * Widths are measured by the caller (fonts and zoom decide them), so the rule
 * itself stays pure and testable: fill in order, then give back trailing chips
 * until `+N` fits beside them. One chip always survives, so a very narrow row
 * still says what it is about instead of showing only `+6`.
 */
export function fitSubagentChips(input: {
  widths: readonly number[];
  gap: number;
  available: number;
  moreWidth: number;
}): ChipFit {
  const { widths, gap, available, moreWidth } = input;
  if (widths.length === 0) return { visible: 0, hidden: 0 };

  let used = 0;
  let visible = 0;
  for (let index = 0; index < widths.length; index += 1) {
    const next = used + (index > 0 ? gap : 0) + widths[index];
    if (next > available) break;
    used = next;
    visible += 1;
  }
  if (visible === widths.length) return { visible, hidden: 0 };

  let hidden = widths.length - visible;
  while (visible > 1 && used + gap + moreWidth > available) {
    visible -= 1;
    used -= widths[visible] + gap;
    hidden += 1;
  }
  // A very narrow row still names one model; the container clips the overflow
  // rather than showing a row that only says `+6`.
  if (visible === 0) return { visible: 1, hidden: widths.length - 1 };
  return { visible, hidden };
}
