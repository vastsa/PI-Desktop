import { parseComposerPromptDisplay } from "@pi-desktop/shared";
import { nextChipToken } from "../../../lib/composer-chip-token";
import type { ComposerDraftSnapshot } from "../../../lib/composer-smart-stop";

/** Rehydrate a queued reference after renderer or host restart. */
export function restoreComposerReferenceDraft(content: string, display: unknown): ComposerDraftSnapshot {
  const parsed = parseComposerPromptDisplay(display);
  if (!parsed) return { text: content, fileReferences: [] };
  let text = "";
  let at = 0;
  const fileReferences: ComposerDraftSnapshot["fileReferences"] = [];
  for (const reference of parsed.references) {
    const token = nextChipToken();
    text += parsed.content.slice(at, reference.start) + token;
    fileReferences.push({
      kind: "reference", path: "", name: reference.label, token,
      pluginReference: { pluginId: reference.pluginId, providerId: reference.providerId, refId: reference.refId, label: reference.label },
    });
    at = reference.end;
  }
  text += parsed.content.slice(at);
  return { text, fileReferences };
}
