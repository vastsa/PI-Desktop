/**
 * Motion style for the promoted ("send now pending") queue row.
 *
 * The promoted row always keeps its accent bar; this setting only chooses the
 * motion layered on top. `off` (the default) is the static bar alone. Every
 * variant is pure CSS keyed off the root `data-queue-animation` attribute and
 * stands down under `prefers-reduced-motion`.
 */

export const QUEUED_PROMPT_ANIMATIONS = [
  "off",
  "bubbles",
  "glow",
  "wave",
] as const;

export type QueuedPromptAnimation = (typeof QUEUED_PROMPT_ANIMATIONS)[number];

export const DEFAULT_QUEUED_PROMPT_ANIMATION: QueuedPromptAnimation = "off";

export function isQueuedPromptAnimation(
  value: unknown,
): value is QueuedPromptAnimation {
  return (
    typeof value === "string" &&
    (QUEUED_PROMPT_ANIMATIONS as readonly string[]).includes(value)
  );
}

export function resolveQueuedPromptAnimation(settings: {
  queuedPromptAnimation?: unknown;
}): QueuedPromptAnimation {
  return isQueuedPromptAnimation(settings.queuedPromptAnimation)
    ? settings.queuedPromptAnimation
    : DEFAULT_QUEUED_PROMPT_ANIMATION;
}
