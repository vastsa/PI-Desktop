import {
  SESSION_THINKING_LEVELS,
  THINKING_LEVELS,
  type SessionThinkingLevel,
  type ThinkingLevel,
} from "./types.js";

export function isSessionThinkingLevel(value: unknown): value is SessionThinkingLevel {
  return typeof value === "string" && (SESSION_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Map omit onto bookkeeping `off` for APIs that only accept canonical levels. */
export function canonicalThinkingLevel(level: SessionThinkingLevel): ThinkingLevel {
  return level === "omit" ? "off" : level;
}

/** Composer menu: do-not-send first, then the binding's enabled canonical levels. */
export function sessionThinkingMenuLevels(
  available: readonly ThinkingLevel[] | undefined,
): SessionThinkingLevel[] {
  if (!available || available.length === 0) return ["off"];
  return ["omit", ...available];
}

function enablesReasoning(levels: readonly ThinkingLevel[] | undefined): boolean {
  return Boolean(levels?.some((level) => level !== "off"));
}

/**
 * Settings default picker: `omit` first when the binding enables any
 * reasoning level. Capability chips stay canonical.
 */
export function bindingDefaultThinkingMenuLevels(
  enabled: readonly ThinkingLevel[] | undefined,
): SessionThinkingLevel[] {
  const levels = enabled?.length ? [...enabled] : [];
  if (!enablesReasoning(levels)) return levels.length > 0 ? levels : ["off"];
  return ["omit", ...levels];
}

/** Keep a stored default when it is still a legal picker value. */
export function resolveBindingDefaultThinkingLevel(
  stored: SessionThinkingLevel | null | undefined,
  enabled: readonly ThinkingLevel[] | undefined,
): SessionThinkingLevel | null {
  const choices = bindingDefaultThinkingMenuLevels(enabled);
  if (stored && choices.includes(stored)) return stored;
  return enabled?.[0] ?? null;
}

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

/** Binding fields that seed a new draft or session thinking level. */
export type ThinkingLevelBindingSource = {
  thinkingLevels?: readonly ThinkingLevel[] | null;
  defaultThinkingLevel?: SessionThinkingLevel | null;
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

function initialThinkingLevelForBindingInternal(
  binding: ThinkingLevelBindingSource | null | undefined,
  fallbackLevels?: readonly ThinkingLevel[],
  defaultToOff = false,
): SessionThinkingLevel {
  const enabled = binding?.thinkingLevels ?? fallbackLevels;
  const stored = binding?.defaultThinkingLevel;
  if (stored === "omit") return enablesReasoning(enabled) ? "omit" : "off";
  if (stored != null) return nearestSupportedThinkingLevel(stored, enabled);
  return defaultToOff ? "off" : highestSupportedThinkingLevel(enabled);
}

/**
 * Thinking level a new draft or session starts at for a known model binding.
 *
 * Prefer the stored default when it is still enabled, including `omit` on a
 * reasoning binding. Otherwise clamp that default onto the enabled ladder.
 * With no stored default, fall back to the strongest enabled level so a
 * reasoning model never starts at `off` merely because Settings has not
 * picked a default yet.
 */
export function initialThinkingLevelForBinding(
  binding: ThinkingLevelBindingSource | null | undefined,
  fallbackLevels?: readonly ThinkingLevel[],
): SessionThinkingLevel {
  return initialThinkingLevelForBindingInternal(binding, fallbackLevels);
}

/**
 * Thinking level for a model absent from the catalog.
 *
 * An explicit binding default still wins, but an unknown model must not
 * enable reasoning implicitly. Its available levels remain selectable in the
 * Composer while a new draft/session starts at `off`.
 */
export function initialThinkingLevelForUnmatchedModel(
  binding: ThinkingLevelBindingSource | null | undefined,
  fallbackLevels?: readonly ThinkingLevel[],
): SessionThinkingLevel {
  return initialThinkingLevelForBindingInternal(binding, fallbackLevels, true);
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
