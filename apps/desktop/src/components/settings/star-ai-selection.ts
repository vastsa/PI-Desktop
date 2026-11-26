import { starAiGroupService, type StarAiCatalog, type StarAiService } from "@pi-desktop/shared";

export type StarAiDraft = { service: StarAiService | null; group: string; model: string };
export const emptyStarAiDraft: StarAiDraft = { service: null, group: "", model: "" };

/** Keep the user's place on refresh, while dropping choices removed from the marketplace. */
export function starAiDraft(catalog: StarAiCatalog, preferred?: StarAiDraft | null): StarAiDraft {
  const choice = preferred ?? catalog.selection;
  if (!choice) return emptyStarAiDraft;
  const isChatGroup = (entry: StarAiCatalog["groups"][number]) =>
    (entry.chatModels?.length ?? 0) > 0 && (entry.id === "auto" || starAiGroupService(entry.id) !== "media");
  const group = catalog.groups.find((entry) => entry.id === choice.group && isChatGroup(entry));
  if (group) {
    return {
      service: group.id === "auto" ? null : starAiGroupService(group.id),
      group: group.id,
      model: group.chatModels?.includes(choice.model) ? choice.model : "",
    };
  }
  const service = preferred?.service;
  if (service && service !== "media" && catalog.groups.some((entry) => entry.id !== "auto" && isChatGroup(entry) && starAiGroupService(entry.id) === service)) {
    return { service, group: "", model: "" };
  }
  return emptyStarAiDraft;
}
