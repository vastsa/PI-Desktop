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
  categories?: string[];
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
