/**
 * Public review reads: the values the plugins page shows, and the state a
 * review list moves through.
 *
 * Reviews are written on the plugin center, so the desktop only ever reads
 * them. Everything here is pure transformation — what a chip says, how one
 * page of results folds into the list, and which answer belongs to the query
 * still on screen — so the drawer's behaviour is testable without an IPC
 * boundary. Fetching lives in `usePluginReviews`.
 */
import type {
  PluginReview,
  PluginReviewPage,
  PluginReviewQuery,
  PluginReviewSummary,
} from "@pi-desktop/shared";

/** The sentiment filter the center accepts; `all` asks for every visible row. */
export type ReviewSentiment = "all" | "positive" | "neutral" | "negative";

/** Order the center offers; both cursors stay bound to the choice. */
export type ReviewSort = "newest" | "helpful";

export const REVIEW_SENTIMENTS: readonly ReviewSentiment[] = [
  "all",
  "positive",
  "neutral",
  "negative",
];

export const REVIEW_SORTS: readonly ReviewSort[] = ["newest", "helpful"];

/** Catalog keys for the filter chips and the distribution rows. */
export const REVIEW_SENTIMENT_LABEL_KEYS: Record<ReviewSentiment, string> = {
  all: "plugins.reviews.sentimentAll",
  positive: "plugins.reviews.sentimentPositive",
  neutral: "plugins.reviews.sentimentNeutral",
  negative: "plugins.reviews.sentimentNegative",
};

/** Catalog keys for the sort chips. */
export const REVIEW_SORT_LABEL_KEYS: Record<ReviewSort, string> = {
  newest: "plugins.reviews.sortNewest",
  helpful: "plugins.reviews.sortHelpful",
};

/** One page of reviews, as the contract's `limit` default. */
export const REVIEW_PAGE_LIMIT = 20;

/**
 * Origin of the plugin center. The host bridge returns the effective
 * `reviewUrl` for whatever catalog origin is in effect (a fixture environment
 * override included); this is the fallback used when only the plugin id is
 * known, so the write link never depends on catalogue or review content.
 */
export const OFFICIAL_PLUGIN_CENTER_ORIGIN = "https://plugins.aiuo.net";

/** The public page where a review for `pluginId` is written. */
export function officialReviewUrl(pluginId: string): string {
  return `${OFFICIAL_PLUGIN_CENTER_ORIGIN}/plugins/${encodeURIComponent(pluginId)}#reviews`;
}

/**
 * Prefer the host-provided page URL; fall back to the official page. A value
 * that is not an http(s) URL is refused rather than rendered as a link.
 */
export function effectiveReviewUrl(
  pluginId: string,
  pageUrl: string | null | undefined,
): string {
  const trimmed = pageUrl?.trim();
  if (trimmed && /^https?:\/\//i.test(trimmed)) return trimmed;
  return officialReviewUrl(pluginId);
}

/** The identity of one review query: switching any part starts a new list. */
export function reviewQueryKey(
  pluginId: string,
  sentiment: ReviewSentiment,
  sort: ReviewSort,
): string {
  return [pluginId, sentiment, sort].join("\u0000");
}

/**
 * Append a page without ever repeating a row. Helpful ordering is not a
 * snapshot, so a review can move between pages while the user reads; the id
 * is what decides whether a row was already shown.
 */
export function mergeReviews(
  existing: readonly PluginReview[],
  incoming: readonly PluginReview[],
): PluginReview[] {
  const seen = new Set(existing.map((review) => review.id));
  const merged = [...existing];
  for (const review of incoming) {
    if (seen.has(review.id)) continue;
    seen.add(review.id);
    merged.push(review);
  }
  return merged;
}

/**
 * The average, written with the locale's decimal separator and exactly one
 * decimal. `null` means the centre reported no average (no visible reviews),
 * which is not the same as zero.
 */
export function formatRatingAvg(
  avg: number | null | undefined,
  locale: string,
): string | null {
  if (avg == null || !Number.isFinite(avg)) return null;
  try {
    return new Intl.NumberFormat(locale || undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(avg);
  } catch {
    return avg.toFixed(1);
  }
}

/** One review's half-star rating as a star value (`9` → `4.5`, `10` → `5`). */
export function formatReviewRating(halfStars: number): string {
  const stars = Math.max(0, halfStars) / 2;
  const fixed = stars.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

export type SentimentShare = {
  key: "positive" | "neutral" | "negative";
  count: number;
  percent: number;
};

/**
 * The distribution readout: how many ratings each sentiment holds, each as a
 * share of the three buckets. A summary with no rows yields zeroed buckets so
 * the surface keeps its shape rather than dividing by zero.
 */
export function sentimentShares(
  summary:
    | Pick<PluginReviewSummary, "positiveCount" | "neutralCount" | "negativeCount">
    | null
    | undefined,
): SentimentShare[] {
  const counts = {
    positive: Math.max(0, summary?.positiveCount ?? 0),
    neutral: Math.max(0, summary?.neutralCount ?? 0),
    negative: Math.max(0, summary?.negativeCount ?? 0),
  };
  const total = counts.positive + counts.neutral + counts.negative;
  return (["positive", "neutral", "negative"] as const).map((key) => ({
    key,
    count: counts[key],
    percent: total > 0 ? Math.round((counts[key] / total) * 100) : 0,
  }));
}

/**
 * The summary map a successful batched answer produces.
 *
 * A success is the whole truth for the ids that were asked about: the centre
 * deliberately omits ids it no longer serves (an archived or unpublished
 * plugin), so an id the answer omits must lose its rating rather than keep an
 * older one merged underneath. Ids that were not requested are ignored, so a
 * stray key cannot leak into the map.
 */
export function nextSummaryMap(
  requestedIds: readonly string[],
  response: Record<string, PluginReviewSummary>,
): Record<string, PluginReviewSummary> {
  const next: Record<string, PluginReviewSummary> = {};
  for (const id of requestedIds) {
    const answer = response[id];
    if (answer) next[id] = answer;
  }
  return next;
}

export type ReviewListStatus = "idle" | "loading" | "ready" | "error";
/** What the drawer draws, including which query the rows belong to. */
export type ReviewListState = {
  /** `reviewQueryKey` of the rows on screen; null before the first load. */
  key: string | null;
  reviews: PluginReview[];
  nextCursor: string | null;
  summary: PluginReviewSummary | null;
  reviewUrl: string | null;
  status: ReviewListStatus;
  loadingMore: boolean;
  error: string | null;
};

export function initialReviewListState(): ReviewListState {
  return {
    key: null,
    reviews: [],
    nextCursor: null,
    summary: null,
    reviewUrl: null,
    status: "idle",
    loadingMore: false,
    error: null,
  };
}

/**
 * Start the first page for `key`. A different query clears the previous rows —
 * they answer a question the user moved on from; the same query keeps them so
 * a retry never blanks what is already readable.
 */
export function beginReviewLoad(state: ReviewListState, key: string): ReviewListState {
  if (state.key !== key) {
    return { ...initialReviewListState(), key, status: "loading" };
  }
  return {
    ...state,
    status: state.reviews.length ? "ready" : "loading",
    loadingMore: false,
    error: null,
  };
}

/** Fold a first page in; a late answer for another query is ignored. */
export function applyReviewPage(
  state: ReviewListState,
  key: string,
  page: PluginReviewPage,
  pluginId: string,
): ReviewListState {
  if (state.key !== key) return state;
  return {
    ...state,
    reviews: mergeReviews([], page.reviews ?? []),
    nextCursor: page.nextCursor ?? null,
    summary: page.summary ?? state.summary,
    reviewUrl: effectiveReviewUrl(pluginId, page.reviewUrl),
    status: "ready",
    loadingMore: false,
    error: null,
  };
}

/** Append a later page, deduplicated by review id. */
export function applyNextReviewPage(
  state: ReviewListState,
  key: string,
  page: PluginReviewPage,
): ReviewListState {
  if (state.key !== key) return state;
  return {
    ...state,
    reviews: mergeReviews(state.reviews, page.reviews ?? []),
    nextCursor: page.nextCursor ?? null,
    summary: page.summary ?? state.summary,
    loadingMore: false,
    error: null,
  };
}

export function beginReviewLoadMore(state: ReviewListState): ReviewListState {
  return { ...state, loadingMore: true, error: null };
}

/**
 * A failed request for the current query: the whole list becomes an error
 * only when there is nothing to read; a failed "load more" keeps the rows and
 * reports the failure beside them.
 */
export function failReviewLoad(
  state: ReviewListState,
  key: string,
  error: string,
): ReviewListState {
  if (state.key !== key) return state;
  return {
    ...state,
    status: state.reviews.length ? "ready" : "error",
    loadingMore: false,
    error,
  };
}

/** The query object one page request sends. */
export function reviewQuery(
  pluginId: string,
  sentiment: ReviewSentiment,
  sort: ReviewSort,
  cursor?: string | null,
): PluginReviewQuery {
  return {
    pluginId,
    sentiment,
    sort,
    limit: REVIEW_PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
  };
}
