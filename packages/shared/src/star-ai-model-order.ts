/**
 * Deterministic release-date ordering for StarAI models.
 *
 * Newest models appear at the top. Newly launched versioned models that are not
 * yet present in the local models.dev snapshot also sort to the top so future
 * additions naturally prepend above older releases.
 */

const EFFORT_SUFFIX_RE = /-(xhigh|high|medium|low|minimal|tiered|thinking|fast)$/i;

const EFFORT_RANK: Record<string, number> = {
  "": 0,
  xhigh: 1,
  high: 2,
  medium: 3,
  low: 4,
  minimal: 5,
  tiered: 6,
  thinking: 7,
  fast: 8,
};

/**
 * Baseline release dates (YYYY-MM-DD) from models.dev for current StarAI models,
 * used as a fallback before live/bundled catalog metadata is hydrated.
 */
export const STARAI_KNOWN_RELEASE_DATES: Readonly<Record<string, string>> = {
  "gemini-4-neon": "2026-11-18",
  "gpt-6.2-sol": "2026-11-17",
  "gpt-6.2-astra": "2026-11-17",
  "gemini-4-hydrogen": "2026-11-12",
  "gemini-4-carbon": "2026-11-10",
  "claude-fable-5-2": "2026-11-09",
  "gpt-6.1-terra": "2026-10-26",
  "glm-5.3": "2026-10-26",
  "kimi-k3.1-pro": "2026-10-23",
  "deepseek-v4.1-flash": "2026-10-17",
  "gemini-4-argon": "2026-10-13",
  "claude-haiku-5-5": "2026-10-07",
  "gpt-6.1-sol": "2026-09-29",
  "claude-sonnet-5-5": "2026-09-28",
  "gpt-6-sol": "2026-09-22",
  "claude-opus-5-5": "2026-09-22",
  "grok-4.7": "2026-09-21",
  "gpt-image-2.5-sunburst": "2026-09-08",
  "gpt-image-2.5-flare": "2026-09-08",
  "gpt-6-astra": "2026-09-04",
  "gemini-3.8-flash": "2026-09-02",
  "claude-fable-5-1": "2026-09-01",
  "glm-5.3-flash": "2026-08-26",
  "deepseek-v4-pro": "2026-08-13",
  "grok-4.6": "2026-08-12",
  "claude-opus-5": "2026-07-24",
  "gemini-3.5-flash-lite": "2026-07-21",
  "kimi-k3": "2026-07-16",
  "gpt-5.6-terra": "2026-07-09",
  "gpt-5.6-sol": "2026-07-09",
  "gpt-5.6-luna": "2026-07-09",
  "grok-4.5": "2026-07-08",
  "claude-sonnet-5": "2026-06-30",
  "claude-fable-5": "2026-06-09",
  "claude-opus-4-8": "2026-05-28",
  "gpt-image-2": "2026-04-21",
  "claude-opus-4-7": "2026-04-16",
  "gemini-3.1-flash-image-preview": "2026-02-26",
  "claude-sonnet-4-6": "2026-02-17",
  "claude-opus-4-6": "2026-02-05",
  "gemini-3-pro-image-preview": "2025-11-20",
};

function bareModelName(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf("/");
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

export function stripStarAiModelEffortSuffix(modelId: string): string {
  return modelId.trim().replace(EFFORT_SUFFIX_RE, "");
}

function effortSuffixRank(modelId: string): number {
  const match = modelId.trim().match(EFFORT_SUFFIX_RE);
  if (!match) return 0;
  return EFFORT_RANK[match[1].toLowerCase()] ?? 9;
}

function normalizeIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : undefined;
}

export function starAiModelReleaseDate(
  modelId: string,
  lookup?: (id: string) => string | undefined,
): string | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  const base = stripStarAiModelEffortSuffix(trimmed);
  const exactFromLookup = normalizeIsoDate(lookup?.(trimmed));
  if (exactFromLookup) return exactFromLookup;
  if (base !== trimmed) {
    const baseFromLookup = normalizeIsoDate(lookup?.(base));
    if (baseFromLookup) return baseFromLookup;
  }
  const bare = bareModelName(trimmed);
  if (STARAI_KNOWN_RELEASE_DATES[bare]) return STARAI_KNOWN_RELEASE_DATES[bare];
  const bareBase = bareModelName(base);
  return STARAI_KNOWN_RELEASE_DATES[bareBase];
}

function extractVersionTuple(modelId: string): number[] {
  const bare = bareModelName(stripStarAiModelEffortSuffix(modelId));
  const matches = bare.match(/\d+/g);
  if (!matches) return [];
  return matches.map((part) => Number.parseInt(part, 10)).filter((n) => Number.isFinite(n));
}

function compareVersionsDesc(left: readonly number[], right: readonly number[]): number {
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return b - a;
  }
  return 0;
}

export type SortStarAiModelsOptions = {
  getReleaseDate?: (modelId: string) => string | undefined;
};

/**
 * Sort StarAI model IDs newest-first:
 * - Tier 0: Uncatalogued newly added versioned models (e.g. brand-new releases
 *   not yet indexed in models.dev) appear at the very top.
 * - Tier 1: Models with a known release date (exact or effort-variant base),
 *   ordered by release date descending; same-base effort variants group right
 *   under their base model (`base`, `xhigh`, `high`, `medium`, `low`).
 * - Tier 2: Non-versioned uncatalogued utility aliases at the bottom.
 */
export function sortStarAiModels(
  modelIds: readonly string[],
  options?: SortStarAiModelsOptions,
): string[] {
  const unique = [...new Set(modelIds)];
  const meta = new Map(
    unique.map((id) => {
      const releaseDate = starAiModelReleaseDate(id, options?.getReleaseDate);
      const version = extractVersionTuple(id);
      const base = bareModelName(stripStarAiModelEffortSuffix(id));
      const effortRank = effortSuffixRank(id);
      // Tier 0 = new versioned release not yet in models.dev
      // Tier 1 = dated release (exact or base-variant)
      // Tier 2 = unversioned utility alias
      const tier = releaseDate ? 1 : version.length > 0 ? 0 : 2;
      return [id, { releaseDate, version, base, effortRank, tier }] as const;
    }),
  );

  return unique.sort((a, b) => {
    const left = meta.get(a)!;
    const right = meta.get(b)!;
    if (left.tier !== right.tier) return left.tier - right.tier;

    if (left.tier === 1) {
      if (left.releaseDate !== right.releaseDate) {
        return right.releaseDate!.localeCompare(left.releaseDate!);
      }
      if (left.base === right.base && left.effortRank !== right.effortRank) {
        return left.effortRank - right.effortRank;
      }
    }

    const versionCmp = compareVersionsDesc(left.version, right.version);
    if (versionCmp !== 0) return versionCmp;

    if (left.base === right.base && left.effortRank !== right.effortRank) {
      return left.effortRank - right.effortRank;
    }

    return a.localeCompare(b);
  });
}
