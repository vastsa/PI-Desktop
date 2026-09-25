/**
 * The `composerControl` outlet of one toolbar side
 * (`docs/plugin-plan/ui/composer/`). Controls stack in registration order,
 * each in its own boundary; their only prop is the side they are mounted on,
 * and they reach the draft through `pi.dispatch`, never through props.
 */
import type {
  PluginComposerControlSlotProps,
  PluginSlotPosition,
} from "@pi-desktop/plugin-sdk";
import {
  SlotBoundary,
  slotElement,
  useSlotEntries,
} from "../../../plugins/renderer-slots/use-slots";

export function ComposerControlSlots({ side }: { side: PluginSlotPosition }) {
  const entries = useSlotEntries("composerControl", side);
  if (entries.length === 0) return null;
  const props: PluginComposerControlSlotProps = { position: side };
  return (
    <>
      {entries.map((entry) => (
        <SlotBoundary key={entry.id} entry={entry}>
          {slotElement(entry, props)}
        </SlotBoundary>
      ))}
    </>
  );
}
