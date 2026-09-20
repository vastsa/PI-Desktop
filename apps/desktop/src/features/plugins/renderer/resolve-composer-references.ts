import { formatFileInsert, type AgentPromptAttachment, type ComposerPromptDisplay } from "@pi-desktop/shared";
import type { ComposerDraftSnapshot } from "../../../lib/composer-smart-stop";
import { composerPluginRegistry } from "./composer-registry";

/** Capture each selected reference once; one failing plugin only loses its own expansion. */
export async function resolveComposerReferences(content: string, draft?: ComposerDraftSnapshot): Promise<{
  content: string;
  composerDisplay?: ComposerPromptDisplay;
  attachments: AgentPromptAttachment[];
}> {
  if (!draft?.fileReferences.some((item) => item.kind === "reference" && item.pluginReference && item.token && draft.text.includes(item.token))) return { content, attachments: [] };
  const controller = new AbortController();
  const byToken = new Map(draft.fileReferences.filter((item) => item.token).map((item) => [item.token!, item]));
  const resolved = new Map<string, string>();
  const attachments: AgentPromptAttachment[] = [];
  let remaining = 64000;
  for (const item of draft.fileReferences) {
    const reference = item.pluginReference;
    if (!reference || !item.token || !draft.text.includes(item.token) || resolved.has(item.token)) continue;
    try {
      const result = await composerPluginRegistry.resolve(reference, controller.signal);
      if (typeof result?.text !== "string" || result.text.length > remaining) throw new Error("Plugin reference exceeds the prompt budget");
      const pendingAttachments = result.attachments ?? [];
      if (!Array.isArray(pendingAttachments) || attachments.length + pendingAttachments.length > 32) throw new Error("Invalid plugin reference attachments");
      for (const attachment of pendingAttachments) {
        if (attachments.length >= 32 || !attachment || typeof attachment.path !== "string" || typeof attachment.name !== "string" || (attachment.kind !== "file" && attachment.kind !== "image")) throw new Error("Invalid plugin reference attachment");
      }
      remaining -= result.text.length;
      resolved.set(item.token, result.text);
      attachments.push(...pendingAttachments);
    } catch (error) {
      resolved.set(item.token, reference.label);
      console.warn(`[plugin:${reference.pluginId}] reference resolution failed`, error);
    }
  }
  let visible = "";
  let model = "";
  const references: ComposerPromptDisplay["references"] = [];
  const source = draft.text.trim();
  for (let index = 0; index < source.length; index += 1) {
    const token = source[index];
    const item = byToken.get(token);
    if (!item) { visible += token; model += token; continue; }
    const literal = item.pluginReference?.label ?? formatFileInsert(item.path, "file").trim();
    const start = visible.length;
    visible += literal;
    model += resolved.get(token) ?? literal;
    if (item.pluginReference) {
      references.push({ start, end: visible.length, pluginId: item.pluginReference.pluginId, providerId: item.pluginReference.providerId, refId: item.pluginReference.refId, label: literal });
    }
    const next = source[index + 1];
    if (next && !/\s/.test(next)) { visible += " "; model += " "; }
  }
  return { content: model, composerDisplay: { content: visible, references }, attachments };
}
