import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";
import type { ThinkingLevelMode } from "./types/sessions.js";

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

/** Baseline `thinkingLevel` a session starts from while in `auto` mode (ADR 0257). */
export const AUTO_THINKING_BASELINE: ThinkingLevel = "medium";

/**
 * Default session-layer thinking-level mode (ADR 0257): new sessions and new
 * bindings start in `auto`; persisted sessions without the field stay `manual`.
 */
export const DEFAULT_THINKING_LEVEL_MODE: ThinkingLevelMode = "auto";

/**
 * Clamp the `auto`-mode baseline onto a model's published ladder.
 *
 * Uses the canonical nearest-supported rule (`nearestSupportedThinkingLevel`).
 * With no published levels (non-reasoning model, or an empty list) the result
 * is `off`; non-reasoning models cannot spend thinking tokens.
 */
export function resolveAutoThinkingLevel(
  baseline: ThinkingLevel,
  levels: readonly ThinkingLevel[] | undefined,
): ThinkingLevel {
  if (baseline === "off" || !levels?.length) return "off";
  return nearestSupportedThinkingLevel(baseline, levels);
}

/**
 * Effective thinking level for a session before a turn is dispatched.
 *
 * `thinkingLevelMode: "auto"` treats `thinkingLevel` as a per-turn baseline and
 * resolves it through `resolveAutoThinkingLevel`; any other value (absent,
 * `null`, or `"manual"`) is classic behavior — the stored `thinkingLevel`
 * clamped via `nearestSupportedThinkingLevel`. Callers pass the model's
 * published/enabled levels (`publishedThinkingLevels` output or the binding's
 * enabled list).
 */
export function effectiveThinkingLevelForSession(
  source: { thinkingLevel: ThinkingLevel; thinkingLevelMode?: ThinkingLevelMode | null },
  levels?: readonly ThinkingLevel[],
): ThinkingLevel {
  if (source.thinkingLevelMode === "auto") {
    return resolveAutoThinkingLevel(source.thinkingLevel || AUTO_THINKING_BASELINE, levels);
  }
  return nearestSupportedThinkingLevel(source.thinkingLevel, levels);
}

/** Binding fields that seed a new draft or session thinking level. */
export type ThinkingLevelBindingSource = {
  thinkingLevels?: readonly ThinkingLevel[] | null;
  defaultThinkingLevel?: ThinkingLevel | null;
};

/**
 * Clamp a requested level onto an enabled ladder with the canonical
 * nearest-supported rule: walk up first, then down, then `off`.
 */
export function nearestSupportedThinkingLevel(
  requested: ThinkingLevel,
  levels: readonly ThinkingLevel[] | undefined,
): ThinkingLevel {
  const supported = new Set(levels ?? []);
  if (supported.size === 0) return "off";
  if (supported.has(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.has(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.has(candidate)) return candidate;
  }
  return "off";
}

/**
 * Thinking level a new draft or session starts at for a model binding.
 *
 * Prefer the stored default when it is still enabled; otherwise clamp that
 * default onto the enabled ladder. With no stored default, fall back to the
 * strongest enabled level so a reasoning model never starts at `off` merely
 * because Settings has not picked a default yet.
 */
export function initialThinkingLevelForBinding(
  binding: ThinkingLevelBindingSource | null | undefined,
  fallbackLevels?: readonly ThinkingLevel[],
): ThinkingLevel {
  const enabled = binding?.thinkingLevels ?? fallbackLevels;
  const stored = binding?.defaultThinkingLevel;
  if (stored != null) return nearestSupportedThinkingLevel(stored, enabled);
  return highestSupportedThinkingLevel(enabled);
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
 * The list represents the levels published by the catalog. Settings uses it to
 * seed known-model bindings and explain the catalog baseline; it is not a gate
 * on explicit levels a user configures for a proxy or newly released model.
 */
export function publishedThinkingLevels(
  model?: PublishedThinkingSource | null,
): ThinkingLevel[] {
  if (!model) return [];
  // ADR 0114: no published reasoning support is an empty list, never a token
  // `off` entry.
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
