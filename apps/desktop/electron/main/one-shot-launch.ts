/**
 * Resolve the model for a one-shot completion that can be pinned in Settings
 * (prompt enhancement, ADR 0121; session title generation, ADR 0322).
 *
 * A pinned model is a preference, not a hard requirement: a pin whose provider
 * was disabled, whose account was signed out, or whose binding no longer
 * exists must not take the action down. Try the pin, fall back to the caller's
 * model (the Composer's or the session's), and report why so main can log it.
 *
 * Kept free of Electron and pi-ai imports so the selection rule is directly
 * testable.
 */

export type OneShotModelChoice = {
  providerId?: string;
  modelId?: string;
};

export type PinnedOneShotLaunchOptions<T> = {
  /** Settings pin; an empty provider id means "no pin". */
  pinned: OneShotModelChoice;
  /** The model used when there is no pin, or when the pin cannot launch. */
  fallback: OneShotModelChoice;
  launch: (providerId?: string, modelId?: string) => Promise<T>;
  /** Called once when a pin could not launch, before the fallback is tried. */
  onPinUnavailable?: (error: unknown) => void;
};

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Read a provider/model pin from untyped settings, trimming blanks away. */
export function pinnedOneShotModel(
  settings: Record<string, unknown> | null | undefined,
  providerKey: string,
  modelKey: string,
): OneShotModelChoice {
  return {
    providerId: trimmed(settings?.[providerKey]) || undefined,
    modelId: trimmed(settings?.[modelKey]) || undefined,
  };
}

/**
 * Launch the pinned model when one is set, otherwise the fallback. A pin
 * failure falls back exactly once; a fallback failure propagates unchanged.
 */
export async function resolvePinnedOneShotLaunch<T>({
  pinned,
  fallback,
  launch,
  onPinUnavailable,
}: PinnedOneShotLaunchOptions<T>): Promise<T> {
  if (pinned.providerId) {
    try {
      return await launch(pinned.providerId, pinned.modelId || undefined);
    } catch (error) {
      onPinUnavailable?.(error);
    }
  }
  return launch(fallback.providerId, fallback.modelId);
}
