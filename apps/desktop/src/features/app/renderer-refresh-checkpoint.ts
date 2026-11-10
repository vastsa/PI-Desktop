import { createWorkPanelFileRequest, isKnownWorkPanelTab,
  type WorkPanelContext, type WorkPanelTab } from "../../lib/work-panel-tabs";
import type { ComposerDraftSnapshot, ComposerPluginPart } from "../../lib/composer-smart-stop";
import type { SubagentDraftCheckpoint } from "../subagents/control-drafts";

export const RENDERER_REFRESH_KEY = "pi-desktop:renderer-refresh:v1";
export const MAX_REFRESH_CHECKPOINT_BYTES = 8 * 1024 * 1024;
export type RendererRefreshCheckpoint = {
  version: 1;
  page: "chat" | "scheduled" | "plugins" | "settings";
  sessionId?: string;
  composerDrafts: Array<{ key: string; draft: ComposerDraftSnapshot; workspacePath?: string }>;
  subagentDrafts: SubagentDraftCheckpoint[];
  panels: Array<{ sessionId: string; context: WorkPanelContext }>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const optionalString = (value: unknown): value is string | undefined => value === undefined || string(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const optionalPosition = (value: unknown) => value === undefined || positive(value);

function pluginPart(value: unknown): ComposerPluginPart | undefined {
  if (!record(value) || !string(value.pluginId)) throw new Error("Invalid draft plugin reference");
  if (value.kind === "mark" && string(value.send)) return { kind: value.kind, pluginId: value.pluginId, send: value.send };
  if (value.kind === "fold" && string(value.send) && positive(value.count)) {
    return { kind: value.kind, pluginId: value.pluginId, send: value.send, count: value.count };
  }
  if (value.kind === "attachment" && string(value.id) && Number.isSafeInteger(value.size) && Number(value.size) >= 0) {
    return { kind: value.kind, pluginId: value.pluginId, id: value.id, size: Number(value.size) };
  }
  throw new Error("Invalid draft plugin reference");
}
function composerDraft(value: unknown): RendererRefreshCheckpoint["composerDrafts"][number] {
  if (!record(value) || !string(value.key) || !value.key || !record(value.draft)
    || !string(value.draft.text) || !Array.isArray(value.draft.fileReferences) || !optionalString(value.workspacePath)) {
    throw new Error("Invalid composer draft");
  }
  const fileReferences = value.draft.fileReferences.map((reference: unknown) => {
    if (!record(reference) || !string(reference.path) || !string(reference.name)
      || (reference.kind !== undefined && !["image", "file", "session"].includes(String(reference.kind)))
      || !optionalString(reference.mimeType) || !optionalString(reference.token)) throw new Error("Invalid draft reference");
    return { path: reference.path, name: reference.name,
      ...(reference.kind ? { kind: reference.kind as "image" | "file" | "session" } : {}),
      ...(reference.mimeType ? { mimeType: reference.mimeType } : {}),
      ...(reference.token ? { token: reference.token } : {}),
      ...(reference.plugin === undefined ? {} : { plugin: pluginPart(reference.plugin) }) };
  });
  return { key: value.key, draft: { text: value.draft.text, fileReferences },
    ...(value.workspacePath === undefined ? {} : { workspacePath: value.workspacePath }) };
}
function subagentDraft(value: unknown): SubagentDraftCheckpoint {
  if (!record(value) || !string(value.sessionId) || !value.sessionId || !string(value.text)
    || !string(value.agent) || !string(value.model) || !optionalString(value.delegationId)
    || !optionalString(value.operationId) || !optionalString(value.operationDelegationId)
    || (value.operationId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.operationId))) {
    throw new Error("Invalid subagent draft");
  }
  return { sessionId: value.sessionId, text: value.text, agent: value.agent, model: value.model,
    ...(value.delegationId ? { delegationId: value.delegationId } : {}),
    ...(value.operationId ? { operationId: value.operationId } : {}),
    ...(value.operationDelegationId ? { operationDelegationId: value.operationDelegationId } : {}) };
}
function panel(value: unknown): RendererRefreshCheckpoint["panels"][number] {
  if (!record(value) || !string(value.sessionId) || !value.sessionId || !record(value.context)
    || !Array.isArray(value.context.tabs) || typeof value.context.open !== "boolean"
    || (value.context.activeTabId !== null && !string(value.context.activeTabId))) throw new Error("Invalid panel state");
  const tabs: WorkPanelTab[] = value.context.tabs.map((tab: unknown) => {
    if (!record(tab) || !string(tab.id) || !string(tab.kind) || !optionalString(tab.label)
      || !optionalString(tab.resource) || !optionalString(tab.location) || !optionalString(tab.mimeType)
      || !optionalPosition(tab.line) || !optionalPosition(tab.column)) throw new Error("Invalid panel tab");
    const kind = tab.kind as WorkPanelTab["kind"];
    if (!isKnownWorkPanelTab({ id: tab.id, kind })) throw new Error("Unknown panel tab");
    return { id: tab.id, kind,
      ...(tab.label === undefined ? {} : { label: tab.label }),
      ...(tab.resource === undefined ? {} : { resource: tab.resource }),
      ...(tab.location === undefined ? {} : { location: tab.location }),
      ...(tab.mimeType === undefined ? {} : { mimeType: tab.mimeType }),
      ...(tab.line === undefined ? {} : { line: Number(tab.line) }),
      ...(tab.column === undefined ? {} : { column: Number(tab.column) }) };
  });
  const requestedTabId = value.context.activeTabId;
  const activeTabId = tabs.some((tab) => tab.id === requestedTabId)
    ? String(requestedTabId) : tabs[0]?.id ?? null;
  const active = tabs.find((tab) => tab.id === activeTabId);
  return { sessionId: value.sessionId, context: { open: value.context.open, tabs, activeTabId,
    fileRequest: active ? createWorkPanelFileRequest(active, 1) : null } };
}

/** Session storage is untrusted; decode only UI state, never runnable commands. */
export function parseRendererRefreshCheckpoint(raw: string): RendererRefreshCheckpoint {
  if (new TextEncoder().encode(raw).byteLength > MAX_REFRESH_CHECKPOINT_BYTES) throw new Error("Refresh checkpoint is too large");
  const value: unknown = JSON.parse(raw);
  if (!record(value) || value.version !== 1 || !["chat", "scheduled", "plugins", "settings"].includes(String(value.page))
    || !optionalString(value.sessionId) || !Array.isArray(value.composerDrafts)
    || !Array.isArray(value.subagentDrafts) || !Array.isArray(value.panels)) throw new Error("Invalid refresh checkpoint");
  return { version: 1, page: value.page as RendererRefreshCheckpoint["page"],
    ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    composerDrafts: value.composerDrafts.map(composerDraft), subagentDrafts: value.subagentDrafts.map(subagentDraft),
    panels: value.panels.map(panel) };
}
