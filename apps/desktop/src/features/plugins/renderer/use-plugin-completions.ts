import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { detectTrigger, fuzzyMatchCommand, type ComposerTrigger, type FuzzyMatch } from "@pi-desktop/shared";
import type { ComposerCompletion } from "@pi-desktop/plugin-sdk";
import { composerPluginRegistry, withRendererDeadline, type PluginReference } from "./composer-registry";

export type PluginAutocompleteItem = {
  kind: "reference";
  reference: PluginReference;
  label: string;
  description?: string;
  match: FuzzyMatch;
};
export type PluginComposerTrigger = ComposerTrigger & { triggerChar: string; pluginOnly: boolean };

export function detectPluginComposerTrigger(value: string, cursor: number): PluginComposerTrigger | null {
  const builtin = detectTrigger(value, cursor);
  if (builtin) return { ...builtin, triggerChar: builtin.mode === "file" ? "@" : "/", pluginOnly: false };
  if (cursor < 0 || cursor > value.length) return null;
  const prefix = value.slice(0, cursor);
  const token = prefix.match(/(?:^|[\s"'=])([^\s"'=]+)$/)?.[1];
  if (!token) return null;
  const char = [...token][0];
  if (!char || char === "@" || char === "/") return null;
  if (!composerPluginRegistry.list().some((entry) => entry.provider.trigger === char)) return null;
  return { mode: "file", query: token.slice(char.length), tokenStart: cursor - token.length, tokenEnd: cursor, triggerChar: char, pluginOnly: true };
}

function validCompletion(value: ComposerCompletion): boolean {
  return Boolean(value && typeof value.id === "string" && typeof value.label === "string" && value.reference && typeof value.reference.refId === "string" && value.reference.refId && typeof value.reference.label === "string");
}

export function usePluginCompletions(trigger: PluginComposerTrigger | null, dismissed: boolean, composing: boolean) {
  const revision = useSyncExternalStore(composerPluginRegistry.subscribe, composerPluginRegistry.snapshot);
  const [remote, setRemote] = useState<{ key: string; items: Map<string, readonly ComposerCompletion[]> } | null>(null);
  const key = trigger ? JSON.stringify([trigger.triggerChar, trigger.query, revision]) : "";
  useEffect(() => {
    if (!trigger || dismissed || composing) return;
    const controller = new AbortController();
    const results = new Map<string, readonly ComposerCompletion[]>();
    for (const entry of composerPluginRegistry.list()) {
      if (entry.provider.trigger !== trigger.triggerChar || !entry.provider.search) continue;
      const search = entry.provider.search;
      const query = trigger.query;
      void withRendererDeadline((signal) => search(query, signal), controller.signal, 1500)
        .then((items) => {
          if (controller.signal.aborted) return;
          if (!Array.isArray(items)) throw new Error("Plugin completion search must return an array");
          results.set(JSON.stringify([entry.pluginId, entry.providerId]), items.filter(validCompletion));
          setRemote({ key, items: new Map(results) });
        })
        .catch((error) => {
          if (!controller.signal.aborted) console.warn(`[plugin:${entry.pluginId}] completion search failed`, error);
        });
    }
    return () => controller.abort();
  }, [key, dismissed, composing]);

  return useMemo<PluginAutocompleteItem[]>(() => {
    if (!trigger || dismissed) return [];
    return composerPluginRegistry.list().flatMap((entry) => {
      if (entry.provider.trigger !== trigger.triggerChar) return [];
      const sourceKey = JSON.stringify([entry.pluginId, entry.providerId]);
      const candidates = remote?.key === key ? remote.items.get(sourceKey) ?? entry.provider.items ?? [] : entry.provider.items ?? [];
      return candidates.filter(validCompletion).flatMap((item) => {
        const labelMatch = fuzzyMatchCommand(trigger.query, item.label);
        const keywordMatch = labelMatch ? null : fuzzyMatchCommand(trigger.query, (item.keywords ?? []).join(" "));
        const match = labelMatch ?? (keywordMatch ? { ...keywordMatch, ranges: [] } : null);
        if (!match) return [];
        return [{ kind: "reference" as const, reference: { ...item.reference, pluginId: entry.pluginId, providerId: entry.providerId }, label: item.label, description: item.description, match }];
      });
    });
  }, [key, dismissed, remote]);
}
