import { starAiGroupService, type StarAiCatalog, type StarAiService } from "@pi-desktop/shared";

export type StarAiDraft = { service: StarAiService | null; group: string; model: string };
export const emptyStarAiDraft: StarAiDraft = { service: null, group: "", model: "" };

/** Keep the user's place on refresh, while dropping choices removed from the marketplace. */
export function starAiDraft(catalog: StarAiCatalog, preferred?: StarAiDraft | null): StarAiDraft {
  const choice = preferred ?? catalog.selection;
  if (!choice) return emptyStarAiDraft;
  const group = catalog.groups.find((entry) => entry.id === choice.group && entry.models.length > 0);
  if (group) {
    return {
      service: group.id === "auto" ? null : starAiGroupService(group.id),
      group: group.id,
      model: group.chatModels?.includes(choice.model) ? choice.model : "",
    };
  }
  const service = preferred?.service;
  if (service && catalog.groups.some((entry) => entry.id !== "auto" && entry.models.length && starAiGroupService(entry.id) === service)) {
    return { service, group: "", model: "" };
  }
  return emptyStarAiDraft;
}
