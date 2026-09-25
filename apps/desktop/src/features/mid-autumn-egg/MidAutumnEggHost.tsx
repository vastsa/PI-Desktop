import { useEffect, type ReactElement } from "react";
import {
  hasSeenMidAutumnEgg,
  markMidAutumnEggSeen,
} from "../../lib/mid-autumn-egg-preferences";
import { useMidAutumnEggStore } from "../../stores/mid-autumn-egg-store";
import { MidAutumnEggOverlay } from "./MidAutumnEggOverlay";

/**
 * Launch gate for the Mid-Autumn easter egg.
 *
 * The egg must never compete with the existing boot surface: it only opens once
 * the shell is ready AND the startup splash has finished, and only once per
 * profile. The seen flag is written before the overlay opens, so a crash during
 * playback cannot replay it on every later launch. Later launches, remounts and
 * manual replays from Settings never take this branch.
 */
export function MidAutumnEggHost({
  ready,
  showSplash,
}: {
  ready: boolean;
  showSplash: boolean;
}): ReactElement {
  const open = useMidAutumnEggStore((state) => state.open);
  const showMidAutumnEgg = useMidAutumnEggStore((state) => state.show);
  const hideMidAutumnEgg = useMidAutumnEggStore((state) => state.hide);

  useEffect(() => {
    if (!ready || showSplash) return;
    if (hasSeenMidAutumnEgg()) return;
    markMidAutumnEggSeen();
    showMidAutumnEgg();
  }, [ready, showSplash, showMidAutumnEgg]);

  return <MidAutumnEggOverlay open={open} onClose={hideMidAutumnEgg} />;
}
