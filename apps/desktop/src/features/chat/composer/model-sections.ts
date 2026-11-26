import {
  isStarAiProviderId,
  sortStarAiGroupsByRatio,
  STARAI_CHAT_SERVICES,
  starAiGroupService,
  type ModelInfo,
  type ProviderPublic,
  type StarAiService,
} from "@pi-desktop/shared";

export type ComposerModelGroup = {
  provider: ProviderPublic;
  providerDisplayName: string;
  providerSearchText: string;
  models: ModelInfo[];
};

type Source = { id: string; label: string; count: number; groups: ComposerModelGroup[] } & (
  | { kind: "service"; service: StarAiService }
  | { kind: "auto" | "provider" }
);
export type ComposerModelSection = Source | { id: string; kind: "recent"; count: number };

/** The site's service selector classifies billing groups, including mixed-model groups, by their real group ID. */
export function composerModelSections(groups: ComposerModelGroup[]): Source[] {
  const services = new Map<StarAiService, ComposerModelGroup[]>();
  const otherSources: Source[] = [];
  for (const group of groups) {
    if (!group.models.length) continue;
    const { provider } = group;
    if (!isStarAiProviderId(provider.id)) {
      otherSources.push({ id: `provider:${provider.id}`, kind: "provider", label: group.providerDisplayName,
        count: group.models.length, groups: [group] });
      continue;
    }
    const channel = provider.starAiGroup;
    if (!channel?.chatModels?.length) continue;
    if (channel.id === "auto") {
      otherSources.push({ id: "auto", kind: "auto", label: "auto", count: group.models.length, groups: [group] });
      continue;
    }
    const service = starAiGroupService(channel.id);
    if (service === "media") continue;
    const options = services.get(service) ?? [];
    options.push(group);
    services.set(service, options);
  }
  const serviceSources: Source[] = STARAI_CHAT_SERVICES.flatMap((service) => {
    const options = services.get(service);
    if (!options?.length) return [];
    const sortedGroups = sortStarAiGroupsByRatio(options.map(group => ({ group, ratio: group.provider.starAiGroup?.ratio })));
    return [{ id: `service:${service}`, kind: "service" as const, service, label: service,
      count: options.length, groups: sortedGroups.map(({ group }) => group) }];
  });
  return [...serviceSources, ...otherSources];
}
