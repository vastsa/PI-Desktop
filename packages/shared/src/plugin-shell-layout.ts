/** Public metadata for an existing tab. Resource contents never cross this API. */
export type PluginWorkPanelTab = {
  id: string;
  kind: "new" | "review" | "file" | "plugin" | "subagent";
  label: string;
  resource?: string;
};
export type PluginWorkPanelTabs = { tabs: PluginWorkPanelTab[]; activeTabId: string | null };
export type PluginShellLayout = {
  sidebar: { collapsed: boolean; width: number; minWidth: number; maxWidth: number };
  workPanel: PluginWorkPanelTabs & { visible: boolean; width: number; minWidth: number };
};
export type PluginSidebarLayoutInput = { collapsed?: boolean; width?: number };
export type PluginWorkPanelLayoutInput = { visible?: boolean; width?: number };
export type PluginShellLayoutCommand =
  | { kind: "get" }
  | { kind: "setSidebar"; input: PluginSidebarLayoutInput }
  | { kind: "setWorkPanel"; input: PluginWorkPanelLayoutInput }
  | { kind: "activateTab"; tabId: string };
export type PluginShellLayoutSnapshot = {
  bootId: string;
  revision: number;
  /** Changes on every selection, including selecting the same session again. */
  contextId: string;
  sessionId: string | null;
  /** Project of the displayed session, independent of Main workspace transitions. */
  projectPath: string | null;
  layout: PluginShellLayout;
};
export type PluginShellLayoutRequest = {
  requestId: string;
  bootId: string;
  contextId: string;
  command: PluginShellLayoutCommand;
  /** Deadline checked immediately before applying a queued mutation. */
  expiresAt: number;
};
export type PluginShellLayoutMessage = PluginShellLayoutRequest | { kind: "cancel"; requestId: string };
export type PluginShellLayoutResponse = { requestId: string } & (
  | { snapshot: PluginShellLayoutSnapshot; error?: never }
  | { snapshot?: never; error: { code: string; message: string } }
);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
export function isPluginShellLayoutCommand(value: unknown): value is PluginShellLayoutCommand {
  if (!record(value)) return false;
  if (value.kind === "get") return keys(value, ["kind"]);
  if (value.kind === "activateTab") return keys(value, ["kind", "tabId"]) && typeof value.tabId === "string";
  if (value.kind !== "setSidebar" && value.kind !== "setWorkPanel") return false;
  if (!keys(value, ["kind", "input"]) || !record(value.input)) return false;
  const field = value.kind === "setSidebar" ? "collapsed" : "visible";
  return keys(value.input, [field, "width"]) &&
    (value.input[field] === undefined || typeof value.input[field] === "boolean") &&
    (value.input.width === undefined || finite(value.input.width));
}
export function isPluginShellLayout(value: unknown): value is PluginShellLayout {
  if (!record(value) || !keys(value, ["sidebar", "workPanel"])) return false;
  const { sidebar, workPanel } = value;
  if (!record(sidebar) || !record(workPanel)) return false;
  return keys(sidebar, ["collapsed", "width", "minWidth", "maxWidth"]) &&
    typeof sidebar.collapsed === "boolean" && finite(sidebar.width) && finite(sidebar.minWidth) && finite(sidebar.maxWidth) &&
    keys(workPanel, ["visible", "width", "minWidth", "tabs", "activeTabId"]) &&
    typeof workPanel.visible === "boolean" && finite(workPanel.width) && finite(workPanel.minWidth) &&
    (workPanel.activeTabId === null || text(workPanel.activeTabId)) && Array.isArray(workPanel.tabs) &&
    workPanel.tabs.every((tab) => record(tab) && keys(tab, ["id", "kind", "label", "resource"]) && text(tab.id) &&
      ["new", "review", "file", "plugin", "subagent"].includes(String(tab.kind)) && typeof tab.label === "string" &&
      (tab.resource === undefined || typeof tab.resource === "string"));
}
export function isPluginShellLayoutSnapshot(value: unknown): value is PluginShellLayoutSnapshot {
  return record(value) && keys(value, ["bootId", "revision", "contextId", "sessionId", "projectPath", "layout"]) && text(value.bootId) && text(value.contextId) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && (value.sessionId === null || text(value.sessionId)) && (value.projectPath === null || text(value.projectPath)) && isPluginShellLayout(value.layout);
}
export function isPluginShellLayoutRequest(value: unknown): value is PluginShellLayoutRequest {
  return record(value) && keys(value, ["requestId", "bootId", "contextId", "command", "expiresAt"]) && text(value.requestId) && text(value.bootId) && text(value.contextId) && finite(value.expiresAt) && isPluginShellLayoutCommand(value.command);
}
export function isPluginShellLayoutResponse(value: unknown): value is PluginShellLayoutResponse {
  if (!record(value) || !keys(value, ["requestId", "snapshot", "error"]) || !text(value.requestId)) return false;
  return value.error === undefined ? isPluginShellLayoutSnapshot(value.snapshot) : value.snapshot === undefined && record(value.error) && text(value.error.code) && typeof value.error.message === "string";
}
