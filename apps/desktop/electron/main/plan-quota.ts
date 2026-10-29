/**
 * Subscription coding-plan usage for the vendors that expose a usage endpoint.
 *
 * One query per provider row, resolved like `providersTest`: the caller names
 * the provider row, this module resolves the credential (API key or OAuth
 * token) and only sends it to the vendor host the row (or the vendor's fixed
 * usage host) names. Responses are reduced to percent windows before anything
 * crosses back to the renderer — no secret and no arbitrary vendor payload
 * ever crosses the boundary.
 *
 * Vendor contracts (kept in step with what the vendors actually answer):
 * - Zhipu / Z.AI Coding Plan: `GET {bigmodel.cn|api.z.ai|open.bigmodel.cn}/api/monitor/usage/quota/limit`
 *   with the raw key as `Authorization`; `TOKENS_LIMIT` items carry `unit`
 *   (3 = 5 hours, 6 = weekly) or, on older payloads, no unit at all, plus a
 *   monthly MCP `TIME_LIMIT` counter. Some deployments only answer one of the
 *   URL variants, so each candidate is tried until one yields windows.
 * - DeepSeek: `GET {origin}/user/balance` with `Bearer`; a prepaid balance,
 *   not a rolling window.
 * - Kimi For Coding: `GET api.kimi.com/coding/v1/usages` with `Bearer`; a
 *   weekly summary plus per-window limits whose durations are stated inline.
 * - MiniMax Token Plan: `GET {api.minimaxi.com|api.minimax.io}/v1/token_plan/remains`
 *   with `Bearer`; one interval window and an optional weekly window per
 *   `general` model entry.
 * - ChatGPT Codex (OAuth): `GET chatgpt.com/backend-api/wham/usage` with the
 *   access token; team plans need `ChatGPT-Account-Id`, which is decoded from
 *   the token itself.
 */

import type {
  ProviderPlanQuotaResult,
  ProviderPlanQuotaWindow,
  ProviderPlanQuotaWindowKind,
} from "@pi-desktop/shared";
import { fetchProviderMetadata } from "./provider-metadata-fetch.ts";
import { chatgptAccountId } from "./vendor-live-models.ts";

/** One usage request; the whole query stays inside this budget per candidate. */
const QUOTA_TIMEOUT_MS = 8_000;

const ZHIPU_QUOTA_PATH = "/api/monitor/usage/quota/limit";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

type QuotaRecord = Record<string, unknown>;

function asRecord(value: unknown): QuotaRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as QuotaRecord)
    : undefined;
}

/** Accepts the number-shaped fields vendors return as numbers or numeric strings. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Epoch seconds before ~2286 are scaled to ms; ISO strings parse as dates.
 * Vendors mix both shapes, so every reset time funnels through here.
 */
export function normalizeQuotaTimestamp(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const timestamp = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function unsupported(now: number, message?: string): ProviderPlanQuotaResult {
  return { supported: false, windows: [], updatedAt: now, message };
}

function quotaWindow(
  kind: ProviderPlanQuotaWindowKind,
  usedPercent: number,
  resetAt?: number,
): ProviderPlanQuotaWindow {
  return {
    kind,
    usedPercent: clampPercent(usedPercent),
    ...(resetAt ? { resetAt } : {}),
  };
}

function quotaWindowFromRemaining(
  kind: ProviderPlanQuotaWindowKind,
  remainingPercent: number,
  resetAt?: number,
): ProviderPlanQuotaWindow {
  const remaining = clampPercent(remainingPercent);
  return { ...quotaWindow(kind, 100 - remaining, resetAt), remainingPercent: remaining };
}

/**
 * One usage request. Redirects are refused, never followed: the credential is
 * only ever handed to the URL the caller named, and a 3xx would otherwise
 * carry it to whoever answered the hop.
 */
async function fetchQuotaJson(
  fetchImpl: typeof fetchProviderMetadata,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`usage request was redirected (${response.status})`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error("usage response was not JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Which vendor family a saved base URL can query, or undefined for the rest. */
export type PlanQuotaFamily = "zhipu" | "deepseek" | "kimi" | "minimax";

export function planQuotaFamilyForBaseUrl(
  baseUrl: string,
): PlanQuotaFamily | undefined {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    if (host === "api.z.ai" || host === "open.bigmodel.cn" || host === "bigmodel.cn") {
      return "zhipu";
    }
    if (host === "api.deepseek.com") return "deepseek";
    if (host === "api.kimi.com") return "kimi";
    if (host === "api.minimaxi.com" || host === "api.minimax.io") return "minimax";
    return undefined;
  } catch {
    return undefined;
  }
}

// ===== Zhipu / Z.AI Coding Plan =====

/** Hostname-derived variants first, then the international host as fallback. */
export function zhipuQuotaCandidateUrls(baseUrl: string): string[] {
  let origin = "https://bigmodel.cn";
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    if (host === "api.z.ai" || host === "open.bigmodel.cn") origin = `https://${host}`;
  } catch {
    // Keep the domestic default; the international candidate still runs.
  }
  return [
    ...new Set([
      `${origin}${ZHIPU_QUOTA_PATH}`,
      `${origin}${ZHIPU_QUOTA_PATH}?type=1`,
      `https://api.z.ai${ZHIPU_QUOTA_PATH}`,
      `https://api.z.ai${ZHIPU_QUOTA_PATH}?type=1`,
    ]),
  ];
}

function parseZhipuTokenLimits(limits: readonly QuotaRecord[]): ProviderPlanQuotaWindow[] {
  const tokenLimits = limits
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === "TOKENS_LIMIT");
  const withUnit = tokenLimits.filter(({ item }) => item.unit != null);
  const withoutUnit = tokenLimits
    .filter(({ item }) => item.unit == null)
    .sort((left, right) => {
      const leftReset = normalizeQuotaTimestamp(left.item.nextResetTime);
      const rightReset = normalizeQuotaTimestamp(right.item.nextResetTime);
      if (leftReset && rightReset && leftReset !== rightReset) return leftReset - rightReset;
      return left.index - right.index;
    });

  const windows: ProviderPlanQuotaWindow[] = [];
  for (const { item } of withUnit) {
    const used = asNumber(item.percentage);
    if (used == null) continue;
    const kind: ProviderPlanQuotaWindowKind | undefined =
      item.unit === 3 ? "5h" : item.unit === 6 ? "weekly" : undefined;
    if (!kind) continue;
    windows.push(quotaWindow(kind, used, normalizeQuotaTimestamp(item.nextResetTime)));
  }
  withoutUnit.slice(0, 2).forEach(({ item }, position) => {
    const used = asNumber(item.percentage);
    if (used == null) return;
    windows.push(
      quotaWindow(position === 0 ? "5h" : "weekly", used, normalizeQuotaTimestamp(item.nextResetTime)),
    );
  });
  return windows;
}

function parseZhipuMcpLimit(limits: readonly QuotaRecord[]): ProviderPlanQuotaWindow | undefined {
  const timeLimit = limits.find((item) => item.type === "TIME_LIMIT");
  if (!timeLimit) return undefined;
  const remainingCount = asNumber(timeLimit.remaining) ?? 0;
  const totalCount = asNumber(timeLimit.usage) ?? 0;
  const usedCount =
    asNumber(timeLimit.currentValue) ?? (totalCount > 0 ? totalCount - remainingCount : 0);
  const total = totalCount > 0 ? totalCount : remainingCount + usedCount;
  const remainingPercent = total > 0 ? (remainingCount / total) * 100 : 0;
  return quotaWindowFromRemaining("mcp_monthly", remainingPercent);
}

/** Pure reducer so tests can pin the vendor contract without network access. */
export function parseZhipuQuotaResponse(data: unknown, now: number): ProviderPlanQuotaResult {
  const response = asRecord(data);
  if (response?.success !== true || response?.code !== 200) {
    return unsupported(now, asString(response?.msg) ?? "quota response was not a success payload");
  }
  const payload = asRecord(response?.data);
  const limits = (Array.isArray(payload?.limits) ? (payload?.limits as unknown[]) : [])
    .map(asRecord)
    .filter((item): item is QuotaRecord => item != null);

  const mcpWindow = parseZhipuMcpLimit(limits);
  const windows = [
    ...parseZhipuTokenLimits(limits),
    ...(mcpWindow ? [mcpWindow] : []),
  ];
  if (windows.length === 0) {
    return unsupported(now, "quota response carried no usable windows");
  }
  return { supported: true, planName: "GLM Coding Plan", windows, updatedAt: now };
}

export async function queryZhipuPlanQuota(options: {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetchProviderMetadata;
  timeoutMs?: number;
}): Promise<ProviderPlanQuotaResult> {
  const fetchImpl = options.fetchImpl ?? fetchProviderMetadata;
  const headers = {
    Authorization: options.apiKey,
    Accept: "application/json, text/plain, */*",
  };
  let last: ProviderPlanQuotaResult | undefined;
  for (const url of zhipuQuotaCandidateUrls(options.baseUrl)) {
    try {
      const data = await fetchQuotaJson(fetchImpl, url, headers, options.timeoutMs ?? QUOTA_TIMEOUT_MS);
      const parsed = parseZhipuQuotaResponse(data, Date.now());
      if (parsed.supported && parsed.windows.length > 0) return parsed;
      last = parsed;
    } catch (error) {
      last = unsupported(Date.now(), error instanceof Error ? error.message : "usage request failed");
    }
  }
  return last ?? unsupported(Date.now());
}

// ===== DeepSeek balance =====

export function deepSeekBalanceUrl(baseUrl: string): string {
  try {
    return `${new URL(baseUrl.trim()).origin}/user/balance`;
  } catch {
    return "https://api.deepseek.com/user/balance";
  }
}

function formatBalanceAmount(currency: string | undefined, total: string | undefined): string {
  const amount = (total ?? "0").trim();
  const code = (currency ?? "").toUpperCase();
  if (code === "CNY") return `¥${amount}`;
  if (code === "USD") return `$${amount}`;
  return code ? `${amount} ${code}` : amount;
}

export function parseDeepSeekBalanceResponse(data: unknown, now: number): ProviderPlanQuotaResult {
  const response = asRecord(data);
  const errorMessage = asString(asRecord(response?.error)?.message);
  if (errorMessage) return unsupported(now, errorMessage);
  const balances = Array.isArray(response?.balance_infos)
    ? (response?.balance_infos as unknown[]).map(asRecord).filter(
        (item): item is QuotaRecord => item != null,
      )
    : [];
  if (balances.length === 0) return unsupported(now, "balance response carried no entries");

  const preferred =
    balances.find((item) => (asString(item.currency) ?? "").toUpperCase() === "CNY") ??
    balances.find((item) => (asNumber(item.total_balance) ?? 0) > 0) ??
    balances[0];
  const amountLabel = formatBalanceAmount(asString(preferred.currency), asString(preferred.total_balance));
  const granted = asNumber(preferred.granted_balance) ?? 0;
  const toppedUp = asNumber(preferred.topped_up_balance) ?? 0;
  const total = asNumber(preferred.total_balance) ?? 0;
  const denominator = granted + toppedUp;
  const available = response?.is_available !== false;
  const remainingPercent =
    denominator > 0 ? (total / denominator) * 100 : available ? 100 : 0;
  return {
    supported: true,
    planName: "DeepSeek Balance",
    windows: [
      {
        ...quotaWindowFromRemaining("balance", remainingPercent),
        remainingLabel: amountLabel,
        showProgress: denominator > 0,
      },
    ],
    updatedAt: now,
    ...(available ? {} : { message: "balance is marked unavailable" }),
  };
}

export async function queryDeepSeekBalance(options: {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetchProviderMetadata;
  timeoutMs?: number;
}): Promise<ProviderPlanQuotaResult> {
  try {
    const data = await fetchQuotaJson(
      options.fetchImpl ?? fetchProviderMetadata,
      deepSeekBalanceUrl(options.baseUrl),
      {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
      },
      options.timeoutMs ?? QUOTA_TIMEOUT_MS,
    );
    return parseDeepSeekBalanceResponse(data, Date.now());
  } catch (error) {
    return unsupported(Date.now(), error instanceof Error ? error.message : "usage request failed");
  }
}

// ===== Kimi For Coding =====

const KIMI_UNIT_TO_KIND: Record<string, ProviderPlanQuotaWindowKind> = {
  TIME_UNIT_HOUR: "hours",
  TIME_UNIT_MINUTE: "minutes",
  TIME_UNIT_DAY: "days",
  TIME_UNIT_MONTH: "months",
};

function kimiWindowKind(
  duration: number | undefined,
  timeUnit: string | undefined,
): { kind: ProviderPlanQuotaWindowKind; windowSeconds?: number } {
  const fiveHourWindow =
    (duration === 5 && timeUnit === "TIME_UNIT_HOUR") ||
    (duration === 300 && timeUnit === "TIME_UNIT_MINUTE");
  if (fiveHourWindow) return { kind: "5h", windowSeconds: FIVE_HOUR_SECONDS };
  if (duration == null || !timeUnit) return { kind: "custom" };
  const unitSeconds: Record<string, number> = {
    TIME_UNIT_HOUR: 3_600,
    TIME_UNIT_MINUTE: 60,
    TIME_UNIT_DAY: DAY_SECONDS,
    TIME_UNIT_MONTH: 30 * DAY_SECONDS,
  };
  const seconds = unitSeconds[timeUnit];
  if (!seconds) return { kind: "custom" };
  return { kind: KIMI_UNIT_TO_KIND[timeUnit], windowSeconds: duration * seconds };
}

export function parseKimiQuotaResponse(data: unknown, now: number): ProviderPlanQuotaResult {
  const response = asRecord(data);
  const code = asString(response?.code);
  if (code) return unsupported(now, `usage query rejected: ${code}`);
  const usage = asRecord(response?.usage);
  if (!usage) return unsupported(now, "usage response carried no summary");

  const windows: ProviderPlanQuotaWindow[] = [];
  const summaryRemaining = clampPercent(asNumber(usage.remaining) ?? 0);
  windows.push(quotaWindowFromRemaining("weekly", summaryRemaining, normalizeQuotaTimestamp(usage.resetTime)));

  for (const raw of Array.isArray(response?.limits) ? (response?.limits as unknown[]) : []) {
    const entry = asRecord(raw);
    const detail = asRecord(entry?.detail);
    if (!entry || !detail) continue;
    const windowInfo = asRecord(entry.window);
    const duration = asNumber(windowInfo?.duration);
    const timeUnit = asString(windowInfo?.timeUnit);
    const remaining = clampPercent(asNumber(detail.remaining) ?? 0);
    const { kind, windowSeconds } = kimiWindowKind(duration, timeUnit);
    windows.push({
      ...quotaWindowFromRemaining(kind, remaining, normalizeQuotaTimestamp(detail.resetTime)),
      ...(windowSeconds != null ? { windowSeconds } : {}),
    });
  }
  return {
    supported: true,
    planName: "Kimi For Coding",
    windows,
    updatedAt: now,
  };
}

export async function queryKimiPlanQuota(options: {
  apiKey: string;
  fetchImpl?: typeof fetchProviderMetadata;
  timeoutMs?: number;
}): Promise<ProviderPlanQuotaResult> {
  try {
    const data = await fetchQuotaJson(
      options.fetchImpl ?? fetchProviderMetadata,
      KIMI_USAGE_URL,
      {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
      },
      options.timeoutMs ?? QUOTA_TIMEOUT_MS,
    );
    return parseKimiQuotaResponse(data, Date.now());
  } catch (error) {
    return unsupported(Date.now(), error instanceof Error ? error.message : "usage request failed");
  }
}

// ===== MiniMax Token Plan =====

export function miniMaxQuotaUrl(baseUrl: string): string {
  let url = "https://api.minimaxi.com/v1/token_plan/remains";
  try {
    if (new URL(baseUrl.trim()).hostname.endsWith("minimax.io")) {
      url = "https://api.minimax.io/v1/token_plan/remains";
    }
  } catch {
    // Keep the domestic default.
  }
  return url;
}

export function parseMiniMaxQuotaResponse(data: unknown, now: number): ProviderPlanQuotaResult {
  const response = asRecord(data);
  const baseResponse = asRecord(response?.base_resp);
  const statusCode = asNumber(baseResponse?.status_code);
  if (statusCode != null && statusCode !== 0) {
    return unsupported(now, asString(baseResponse?.status_msg) ?? "usage query was rejected");
  }
  const general = (Array.isArray(response?.model_remains) ? (response?.model_remains as unknown[]) : [])
    .map(asRecord)
    .filter((item): item is QuotaRecord => item != null && item.model_name === "general");
  if (general.length === 0) {
    return unsupported(now, "usage response carried no general-plan entry");
  }

  const windows: ProviderPlanQuotaWindow[] = [];
  for (const item of general) {
    const intervalRemaining = asNumber(item.current_interval_remaining_percent) ?? 100;
    windows.push(
      quotaWindowFromRemaining("5h", intervalRemaining, normalizeQuotaTimestamp(item.end_time)),
    );
    if (asNumber(item.current_weekly_total_count)) {
      const weeklyRemaining = asNumber(item.current_weekly_remaining_percent) ?? 100;
      windows.push(
        quotaWindowFromRemaining("weekly", weeklyRemaining, normalizeQuotaTimestamp(item.weekly_end_time)),
      );
    }
  }
  return {
    supported: true,
    planName: "MiniMax Token Plan",
    windows,
    updatedAt: now,
  };
}

export async function queryMiniMaxPlanQuota(options: {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetchProviderMetadata;
  timeoutMs?: number;
}): Promise<ProviderPlanQuotaResult> {
  try {
    const data = await fetchQuotaJson(
      options.fetchImpl ?? fetchProviderMetadata,
      miniMaxQuotaUrl(options.baseUrl),
      {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
      },
      options.timeoutMs ?? QUOTA_TIMEOUT_MS,
    );
    return parseMiniMaxQuotaResponse(data, Date.now());
  } catch (error) {
    return unsupported(Date.now(), error instanceof Error ? error.message : "usage request failed");
  }
}

// ===== ChatGPT Codex (OAuth) =====

function codexWindowKind(durationSeconds: number): ProviderPlanQuotaWindowKind {
  if (durationSeconds === FIVE_HOUR_SECONDS) return "5h";
  if (durationSeconds === WEEK_SECONDS) return "weekly";
  if (durationSeconds > 0 && durationSeconds % DAY_SECONDS === 0) return "days";
  if (durationSeconds > 3_600 && durationSeconds % 3_600 === 0) return "hours";
  if (durationSeconds > 0 && durationSeconds % 60 === 0) return "minutes";
  return "custom";
}

function formatCodexPlanName(planType: unknown): string {
  const normalized = (asString(planType) ?? "").trim().replace(/[_-]+/g, " ");
  const tier = normalized ? normalized.replace(/\b\w/g, (char) => char.toUpperCase()) : "";
  return tier ? `ChatGPT ${tier} (Codex)` : "ChatGPT (Codex)";
}

export function parseCodexQuotaResponse(data: unknown, now: number): ProviderPlanQuotaResult {
  const response = asRecord(data);
  const rateLimit = asRecord(response?.rate_limit);
  const windows: ProviderPlanQuotaWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const raw = asRecord(rateLimit?.[key]);
    if (!raw) continue;
    const used = asNumber(raw.used_percent);
    const durationSeconds = asNumber(raw.limit_window_seconds);
    if (used == null || durationSeconds == null || durationSeconds <= 0) continue;
    const resetAt =
      normalizeQuotaTimestamp(raw.reset_at) ??
      (asNumber(raw.reset_after_seconds) != null && (asNumber(raw.reset_after_seconds) ?? 0) > 0
        ? now + (asNumber(raw.reset_after_seconds) as number) * 1000
        : undefined);
    windows.push({
      ...quotaWindow(codexWindowKind(durationSeconds), used, resetAt),
      windowSeconds: durationSeconds,
    });
  }
  if (windows.length === 0) {
    return unsupported(now, "usage response carried no rate-limit windows");
  }
  return {
    supported: true,
    planName: formatCodexPlanName(response?.plan_type),
    windows,
    updatedAt: now,
  };
}

export async function queryCodexPlanQuota(options: {
  accessToken: string;
  fetchImpl?: typeof fetchProviderMetadata;
  timeoutMs?: number;
}): Promise<ProviderPlanQuotaResult> {
  const accountId = chatgptAccountId(options.accessToken);
  if (!accountId) {
    return unsupported(Date.now(), "access token does not carry a ChatGPT account id");
  }
  try {
    const data = await fetchQuotaJson(
      options.fetchImpl ?? fetchProviderMetadata,
      CHATGPT_USAGE_URL,
      {
        Authorization: `Bearer ${options.accessToken}`,
        "ChatGPT-Account-Id": accountId,
        Accept: "application/json",
      },
      options.timeoutMs ?? QUOTA_TIMEOUT_MS,
    );
    return parseCodexQuotaResponse(data, Date.now());
  } catch (error) {
    return unsupported(Date.now(), error instanceof Error ? error.message : "usage request failed");
  }
}
