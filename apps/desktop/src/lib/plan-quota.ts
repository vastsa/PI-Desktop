/**
 * Renderer-side support for subscription coding-plan quotas.
 *
 * The main process answers `providersPlanQuota` with percent windows only;
 * this module decides which provider rows can show a quota, de-duplicates the
 * fetches (60s fresh / 15s error TTL, keyed by the row's
 * `updatedAt` so a re-keyed provider never shows the old account's quota),
 * and formats windows through i18n — the payload carries no display strings.
 */

import {
  OAUTH_AUTH_KIND,
  type ProviderPlanQuotaResult,
  type ProviderPlanQuotaWindow,
  type ProviderPublic,
} from "@pi-desktop/shared";
import type { TFunction } from "i18next";
import { api } from "./api";

const FRESH_TTL_MS = 60_000;
const ERROR_TTL_MS = 15_000;

/** Vendor hosts whose base URL implies a queryable usage endpoint. */
const PLAN_QUOTA_HOSTS = new Set([
  "api.z.ai",
  "open.bigmodel.cn",
  "bigmodel.cn",
  "api.deepseek.com",
  "api.kimi.com",
  "api.minimaxi.com",
  "api.minimax.io",
]);

/**
 * Rows worth a quota request. API-key rows qualify by their saved host;
 * of the OAuth vendors only ChatGPT Codex exposes usage to its access token
 * (GitHub Copilot's needs the refresh token main never hands out).
 */
export function supportsProviderPlanQuota(
  provider: Pick<ProviderPublic, "authKind" | "vendorKey" | "baseUrl">,
): boolean {
  if (provider.authKind === OAUTH_AUTH_KIND) return provider.vendorKey === "openai-codex";
  if (!provider.baseUrl) return false;
  try {
    return PLAN_QUOTA_HOSTS.has(new URL(provider.baseUrl.trim()).hostname.toLowerCase());
  } catch {
    return false;
  }
}

interface CachedQuota {
  result: ProviderPlanQuotaResult;
  /** The row's `updatedAt` when the result was fetched; any edit invalidates. */
  version: string;
}

const cache = new Map<string, CachedQuota>();
const inflight = new Map<string, Promise<ProviderPlanQuotaResult>>();

function cacheTtl(result: ProviderPlanQuotaResult): number {
  return result.supported && result.windows.length > 0 ? FRESH_TTL_MS : ERROR_TTL_MS;
}

export function cachedPlanQuota(provider: ProviderPublic): ProviderPlanQuotaResult | null {
  const cached = cache.get(provider.id);
  if (!cached || cached.version !== provider.updatedAt) return null;
  if (Date.now() - cached.result.updatedAt >= cacheTtl(cached.result)) return null;
  return cached.result;
}

/**
 * One network query per provider per TTL, no matter how many badges mount.
 * The cache entry is stored before the promise resolves for awaiters that
 * arrive mid-flight, and a failed call is cached briefly so the periodic
 * refresh cannot turn into a hot retry loop.
 */
export async function fetchProviderPlanQuota(
  provider: ProviderPublic,
): Promise<ProviderPlanQuotaResult> {
  const version = provider.updatedAt;
  const cached = cachedPlanQuota(provider);
  if (cached) return cached;
  cache.delete(provider.id);

  const requestKey = `${provider.id}:${version}`;
  const existing = inflight.get(requestKey);
  if (existing) return existing;

  const request = api
    .getProviderPlanQuota(provider.id)
    .catch((error: unknown): ProviderPlanQuotaResult => ({
      supported: false,
      windows: [],
      updatedAt: Date.now(),
      message: error instanceof Error ? error.message : "quota request failed",
    }))
    .then((result) => {
      const current = cache.get(provider.id);
      if (!current || current.version === version) {
        cache.set(provider.id, { result, version });
      }
      return result;
    })
    .finally(() => {
      inflight.delete(requestKey);
    });
  inflight.set(requestKey, request);
  return request;
}

function remainingOf(window: ProviderPlanQuotaWindow): string {
  if (window.remainingLabel != null) return window.remainingLabel;
  const remaining = window.remainingPercent ?? 100 - window.usedPercent;
  return `${remaining}%`;
}

function windowSecondsUnit(kind: ProviderPlanQuotaWindow["kind"]): number {
  if (kind === "minutes") return 60;
  if (kind === "days") return 86_400;
  if (kind === "months") return 30 * 86_400;
  return 3_600;
}

/** Localized window label; the kind comes from main, the words come from i18n. */
export function planQuotaWindowLabel(
  window: ProviderPlanQuotaWindow,
  t: TFunction,
): string {
  switch (window.kind) {
    case "5h":
      return t("chat.planQuotaWindow5h");
    case "weekly":
      return t("chat.planQuotaWindowWeekly");
    case "mcp_monthly":
      return t("chat.planQuotaWindowMcpMonthly");
    case "balance":
      return t("chat.planQuotaWindowBalance");
    case "premium":
      return t("chat.planQuotaWindowPremium");
    case "chat":
      return t("chat.planQuotaWindowChat");
    case "completions":
      return t("chat.planQuotaWindowCompletions");
    case "billing":
      return t("chat.planQuotaWindowBilling");
    case "hours":
    case "days":
    case "minutes":
    case "months": {
      const seconds = window.windowSeconds ?? windowSecondsUnit(window.kind);
      const count = Math.max(1, Math.round(seconds / windowSecondsUnit(window.kind)));
      const key =
        window.kind === "hours"
          ? "chat.planQuotaWindowHours"
          : window.kind === "days"
            ? "chat.planQuotaWindowDays"
            : window.kind === "minutes"
              ? "chat.planQuotaWindowMinutes"
              : "chat.planQuotaWindowMonths";
      return t(key, { count });
    }
    default:
      return t("chat.planQuotaWindowCustom");
  }
}

function formatResetTime(resetAt: number): string {
  const date = new Date(resetAt);
  if (!Number.isFinite(date.getTime())) return "";
  // "2026/10/28 19:20" — no timezone suffix; local time is what the user reads.
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Panel reset-row entries: "每 5 小时 2026/10/29 20:51" for windows that state one. */
export function planQuotaResetRows(
  windows: readonly ProviderPlanQuotaWindow[],
  t: TFunction,
): string[] {
  return windows
    .filter((window) => window.resetAt)
    .map((window) => {
      const time = window.resetAt ? formatResetTime(window.resetAt) : "";
      return `${planQuotaWindowLabel(window, t)} ${time}`.trim();
    })
    .filter((entry) => entry.length > 0);
}

/** One tooltip line per window: "每 5 小时: 剩余 68%，重置 9/1 20:00". */
export function planQuotaTooltipLines(
  windows: readonly ProviderPlanQuotaWindow[],
  t: TFunction,
): string[] {
  return windows.map((window) => {
    const label = planQuotaWindowLabel(window, t);
    const resetAt = window.resetAt ? formatResetTime(window.resetAt) : "";
    return resetAt
      ? t("chat.planQuotaLineReset", { label, remaining: remainingOf(window), time: resetAt })
      : t("chat.planQuotaLine", { label, remaining: remainingOf(window) });
  });
}

/**
 * The badge summary. 5h and weekly windows lead; a provider without either shows its first two windows, so
 * balance-only rows still have a badge.
 */
export function planQuotaSummaryParts(
  windows: readonly ProviderPlanQuotaWindow[],
  t: TFunction,
): string[] {
  const primary = windows.filter((window) => window.kind === "5h" || window.kind === "weekly");
  const shown = primary.length > 0 ? primary : windows.slice(0, 2);
  return shown.map((window) =>
    t("chat.planQuotaRemainingItem", {
      label: planQuotaWindowLabel(window, t),
      remaining: remainingOf(window),
    }),
  );
}

/** A panel-row item with the leading window label: "每 5 小时 剩余 16%". */
export function planQuotaPanelItem(
  window: ProviderPlanQuotaWindow,
  t: TFunction,
): string {
  return t("chat.planQuotaRemainingItem", {
    label: planQuotaWindowLabel(window, t),
    remaining: remainingOf(window),
  });
}

/** Badge tone flips to warning while any shown window is running out. */
export function planQuotaBadgeTone(
  windows: readonly ProviderPlanQuotaWindow[],
): "neutral" | "warning" {
  const shown = windows.filter(
    (window) => window.kind === "5h" || window.kind === "weekly",
  );
  const relevant = shown.length > 0 ? shown : windows;
  const low = relevant.some((window) => {
    const remaining = window.remainingPercent ?? 100 - window.usedPercent;
    return remaining < 20;
  });
  return low ? "warning" : "neutral";
}
