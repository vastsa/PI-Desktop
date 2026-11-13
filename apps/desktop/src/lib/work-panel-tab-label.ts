import type { PluginViewMeta } from "@pi-desktop/shared";
import { subagentTabDisplayLabels, type WorkPanelTab } from "./work-panel-tabs";

/** One source for both the tab strip's labels and the plugin layout snapshot. */
export function workPanelTabLabel(
  tab: WorkPanelTab,
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
): string {
  if (tab.kind === "plugin") {
    if (tab.resource === "pi.browser/browser" && tab.label) return tab.label;
    const view = pluginViews.find((candidate) => candidate.ref === tab.resource);
    return view?.title ?? tab.resource ?? t("panel.tabs.plugin");
  }
  if (tab.kind === "new") return t("panel.new.title");
  if (tab.kind === "subagent") return tab.label ?? t("panel.tabs.subagent");
  if (tab.kind !== "file") return t(`panel.tabs.${tab.kind}`);
  return (tab.resource ?? "").split("/").filter(Boolean).pop() || t("panel.tabs.file");
}

export function workPanelSubagentLabels(
  tabs: WorkPanelTab[],
  t: (key: string) => string,
  pluginViews: PluginViewMeta[],
): Map<string, string> {
  const subagents = tabs.filter((tab) => tab.kind === "subagent");
  const labels = subagentTabDisplayLabels(subagents.map((tab) => workPanelTabLabel(tab, t, pluginViews)));
  return new Map(subagents.map((tab, index) => [tab.id, labels[index]]));
}
