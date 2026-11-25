/** Shared public types grouped by the owning application domain. */
import type {
  MarketProvenance,
  MarketReview,
  MarketTrust,
} from "./plugins.js";
import type { PluginSummary } from "./plugins.js";

export type MarketPluginSummary = {
  id: string;
  name: string;
  description: string;
  author: string;
  iconUrl?: string;
  latestVersion: string;
  downloads?: number;
  updatedAt: string;
  /** Category labels in the app's language, for display. */
  categories?: string[];
  /** The canonical category ids, for filtering. */
  categoryIds?: string[];
  permissionSummary: string[];
  verified?: boolean;
  /** Catalog v2 trust tier, as the host is willing to render it. */
  trust?: MarketTrust;
  publisherId?: string;
  installed?: boolean;
  installedVersion?: string;
  updateAvailable?: boolean;
  /** False when `latestVersion` has no published package to download yet. */
  installable?: boolean;
  /** True when every catalog version of this plugin has been withdrawn. */
  yanked?: boolean;
};

/** Orders `market.browse` accepts; `recommended` is a seeded shuffle. */
export type MarketBrowseSort = "recommended" | "popular" | "updated" | "name";

export type MarketBrowseQuery = {
  query?: string;
  category?: string;
  sort?: MarketBrowseSort;
  /** Keeps a `recommended` order stable across the pages of one session. */
  seed?: number;
  /** 1-based. */
  page?: number;
  /** Defaults to 24, capped at 60 by the host. */
  pageSize?: number;
};

/** One category and how many of the query's matches carry it. */
export type MarketCategoryFacet = {
  /** The canonical category id; what a filter selects. */
  id: string;
  /** The label for the app's language, when the source published one. */
  name?: string;
  count: number;
};

/** One page of the marketplace, as `market.browse` answers it. */
export type MarketBrowseResult = {
  plugins: MarketPluginSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  sort: MarketBrowseSort;
  categories: MarketCategoryFacet[];
  /** `remote`: the plugin center answered; `local`: the cached snapshot did. */
  source: "remote" | "local";
  /** Why the plugin center's page was not used, when `source` is `local`. */
  fallbackReason?: string;
  providerId: string;
  sourceUrl: string;
};

export type MarketPluginDetail = MarketPluginSummary & {
  readmeMarkdown?: string;
  versions: Array<{
    version: string;
    publishedAt: string;
    changelog?: string;
    minPiDesktop?: string;
    shasum: string;
    url: string;
    sizeBytes: number;
    permissions: string[];
    /** Withdrawn: still listed in history, never offered for install. */
    yanked?: boolean;
    yankedReason?: string;
    provenance?: MarketProvenance;
    review?: MarketReview;
    signature?: string;
    signatureAlg?: string;
    keyId?: string;
  }>;
  screenshots?: string[];
  homepage?: string;
  repository?: string;
  permissions: string[];
  safetyNotes?: string;
};

export type PluginInstallResult = {
  plugin: PluginSummary;
  upgraded: boolean;
  permissionDiff: string[];
};

// --- Public plugin reviews --------------------------------------------------
// Read anonymously through the host from the trusted plugin center. The
// desktop only reads: reviewing happens on the center's own web page, and no
// account, cookie, or device credential crosses this bridge.

/** Aggregated visible reviews for one plugin. */
export type PluginReviewSummary = {
  pluginId: string;
  /** One-decimal average of visible ratings; null when nothing is visible. */
  ratingAvg: number | null;
  ratingCount: number;
  /** Floor star buckets: index 0 is 1 star, index 4 is 5 stars. */
  ratingDist: [number, number, number, number, number];
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
};

/** Moderation state of one review. Public reads carry `visible` only. */
export type PluginReviewStatus = "visible" | "pending" | "hidden" | "deleted";

/**
 * One public review. The account id, a hidden reason, and moderation data are
 * never part of the public shape; the author is shown by `authorName` only.
 */
export type PluginReview = {
  id: string;
  pluginId: string;
  authorName: string;
  /** Rating in half stars, 2..10 (one to five whole stars). */
  ratingHalfStars: number;
  body: string;
  status: PluginReviewStatus;
  pluginVersion: string;
  helpfulCount: number;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
};

/** One page of public reviews plus the trusted center webpage for the plugin. */
export type PluginReviewPage = {
  reviews: PluginReview[];
  nextCursor: string | null;
  summary: PluginReviewSummary;
  /** Built by the host from the effective trusted center origin. */
  reviewUrl: string;
};

/** What one review read asks for. */
export type PluginReviewQuery = {
  pluginId: string;
  cursor?: string;
  limit?: number;
  sentiment?: "all" | "positive" | "neutral" | "negative";
  sort?: "newest" | "helpful";
};

/**
 * One row of a marketplace card's review ticker.
 *
 * The center selects these; the client never re-ranks them. The body is a
 * single quiet line on the card, not a full review surface.
 */
export type PluginReviewTickerRow = {
  id: string;
  authorName: string;
  ratingHalfStars: number;
  body: string;
  helpfulCount: number;
  createdAt: string;
};

/** The selected rows for one plugin, best first, at most ten. */
export type PluginReviewTicker = {
  pluginId: string;
  rows: PluginReviewTickerRow[];
};
