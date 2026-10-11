/**
 * The headings of the composer's completion list, in list order: one per run
 * of `/` commands of one kind, one per plugin group, and one for the host's
 * `@` files when they follow a plugin group (so they don't read as part of
 * it). Rows are drawn in `items` order, which is also the keyboard order.
 */
import type { ComposerCommand } from "@pi-desktop/shared";
import type { CompletionItem } from "./hooks/useComposerCompletions";

export type CompletionGroupHeading =
  | { readonly kind: "command"; readonly group: ComposerCommand["kind"] }
  | { readonly kind: "plugin"; readonly pluginId: string; readonly name: string }
  | { readonly kind: "files" };

/** Heading to draw before the row at each index that starts a group. */
export function completionGroupHeadings(
  items: readonly CompletionItem[],
): Map<number, CompletionGroupHeading> {
  const headings = new Map<number, CompletionGroupHeading>();
  let lastGroup: string | null = null;
  items.forEach((item, index) => {
    if (item.kind === "command") {
      const group = item.command.kind;
      if (group !== lastGroup) {
        lastGroup = group;
        headings.set(index, { kind: "command", group });
      }
    } else if (item.kind === "plugin") {
      const group = `plugin:${item.pluginId}`;
      if (group !== lastGroup) {
        lastGroup = group;
        headings.set(index, { kind: "plugin", pluginId: item.pluginId, name: item.pluginName });
      }
    } else if (lastGroup?.startsWith("plugin:")) {
      lastGroup = "files";
      headings.set(index, { kind: "files" });
    }
  });
  return headings;
}
