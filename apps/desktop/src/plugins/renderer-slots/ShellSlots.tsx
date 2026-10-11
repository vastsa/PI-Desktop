import { SlotBoundary, slotElement, useSlotEntries, useSlotEntryForKey } from "./use-slots";

/** Additive categories in the native main navigation. */
export function PluginNavigationSections() {
  const entries = useSlotEntries("navigationSection");
  return <>{entries.map(entry => <SlotBoundary key={entry.id} entry={entry}>{slotElement(entry, {})}</SlotBoundary>)}</>;
}

/** An owned main page, with the same isolation and disposal as other slots. */
export function PluginMainPage({ page }: { page: string }) {
  const entry = useSlotEntryForKey("mainPage", page.startsWith("plugin:") ? page.slice(7) : undefined);
  return entry ? <SlotBoundary key={entry.id} entry={entry}>{slotElement(entry, {})}</SlotBoundary> : null;
}
