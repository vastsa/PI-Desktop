import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

export function highestSupportedThinkingLevel(
  levels: readonly ThinkingLevel[] | undefined,
): ThinkingLevel {
  const supported = new Set(levels ?? []);
  for (let index = THINKING_LEVELS.length - 1; index >= 0; index -= 1) {
    const level = THINKING_LEVELS[index];
    if (supported.has(level)) return level;
  }
  return "off";
}

/** Published record a thinking-level candidate list can be derived from. */
export type PublishedThinkingSource = {
  reasoning?: boolean;
  supportedThinkingLevels?: readonly ThinkingLevel[];
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

/**
 * Levels a model actually publishes, in canonical order.
 *
 * The runtime intersects the user's enabled levels with this list before a
 * request is built, so a surface that offers levels to enable must offer
 * exactly these. Offering the full canonical ladder instead lets a user enable
 * a level the runtime then drops, which is why a binding could hold more
 * levels than the Composer reasoning menu renders.
 */
export function publishedThinkingLevels(
  model?: PublishedThinkingSource | null,
): ThinkingLevel[] {
  if (!model) return [];
  // ADR 0114: no reasoning support is an empty list, never a token `off` entry.
  // Capability projections spell a non-reasoning model as `["off"]`, which would
  // otherwise surface as one enableable level.
  if (model.reasoning === false) return [];
  const published = new Set<ThinkingLevel>(model.supportedThinkingLevels ?? []);
  if (published.size === 0 && model.thinkingLevelMap) {
    for (const [level, value] of Object.entries(model.thinkingLevelMap)) {
      if (value !== null && value !== undefined) published.add(level as ThinkingLevel);
    }
  }
  if (published.size === 0) {
    return model.reasoning === true ? ["low", "medium", "high"] : [];
  }
  return THINKING_LEVELS.filter((level) => published.has(level));
}
