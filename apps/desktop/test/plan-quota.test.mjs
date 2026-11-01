import assert from "node:assert/strict";
import test from "node:test";
import {
  deepSeekBalanceUrl,
  miniMaxQuotaUrl,
  normalizeQuotaTimestamp,
  parseCodexQuotaResponse,
  parseDeepSeekBalanceResponse,
  parseKimiQuotaResponse,
  parseMiniMaxQuotaResponse,
  parseZhipuQuotaResponse,
  planQuotaFamilyForBaseUrl,
  zhipuQuotaCandidateUrls,
} from "../electron/main/plan-quota.ts";

const NOW = 1_750_000_000_000;

// ===== URL / family resolution =====

test("plan quota family resolves the vendor hosts", () => {
  assert.equal(planQuotaFamilyForBaseUrl("https://api.z.ai/api/coding/paas/v4"), "zhipu");
  assert.equal(planQuotaFamilyForBaseUrl("https://open.bigmodel.cn/api/coding/paas/v4"), "zhipu");
  assert.equal(planQuotaFamilyForBaseUrl("https://api.deepseek.com"), "deepseek");
  assert.equal(planQuotaFamilyForBaseUrl("https://api.kimi.com/coding/v1"), "kimi");
  assert.equal(planQuotaFamilyForBaseUrl("https://api.minimaxi.com/v1"), "minimax");
  assert.equal(planQuotaFamilyForBaseUrl("https://api.minimax.io/anthropic/v1"), "minimax");
  assert.equal(planQuotaFamilyForBaseUrl("https://api.openai.com/v1"), undefined);
  assert.equal(planQuotaFamilyForBaseUrl("not a url"), undefined);
});

test("zhipu quota candidates derive from the saved origin and add the international host", () => {
  const domestic = zhipuQuotaCandidateUrls("https://open.bigmodel.cn/api/coding/paas/v4");
  assert.deepEqual(domestic, [
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=1",
    "https://api.z.ai/api/monitor/usage/quota/limit",
    "https://api.z.ai/api/monitor/usage/quota/limit?type=1",
  ]);

  // An international row collapses to its own two variants, no duplicates.
  const international = zhipuQuotaCandidateUrls("https://api.z.ai/api/coding/paas/v4");
  assert.deepEqual(international, [
    "https://api.z.ai/api/monitor/usage/quota/limit",
    "https://api.z.ai/api/monitor/usage/quota/limit?type=1",
  ]);
});

test("deepseek and minimax usage urls follow the saved origin", () => {
  assert.equal(deepSeekBalanceUrl("https://api.deepseek.com"), "https://api.deepseek.com/user/balance");
  assert.equal(deepSeekBalanceUrl("garbage"), "https://api.deepseek.com/user/balance");
  assert.equal(miniMaxQuotaUrl("https://api.minimaxi.com/v1"), "https://api.minimaxi.com/v1/token_plan/remains");
  assert.equal(miniMaxQuotaUrl("https://api.minimax.io/anthropic/v1"), "https://api.minimax.io/v1/token_plan/remains");
});

// ===== Timestamp normalization =====

test("quota timestamps accept epoch seconds, epoch ms and ISO strings", () => {
  assert.equal(normalizeQuotaTimestamp(1_750_000_000), 1_750_000_000_000);
  assert.equal(normalizeQuotaTimestamp(1_750_000_000_000), 1_750_000_000_000);
  assert.equal(normalizeQuotaTimestamp("2026-01-15T08:00:00Z"), Date.parse("2026-01-15T08:00:00Z"));
  assert.equal(normalizeQuotaTimestamp(""), undefined);
  assert.equal(normalizeQuotaTimestamp(null), undefined);
  assert.equal(normalizeQuotaTimestamp("not a date"), undefined);
});

// ===== Zhipu =====

test("zhipu quota maps unit 3 to 5h and unit 6 to weekly", () => {
  const result = parseZhipuQuotaResponse(
    {
      success: true,
      code: 200,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 6, percentage: 30.4, nextResetTime: 1_750_060_000 },
          { type: "TOKENS_LIMIT", unit: 3, percentage: 45, nextResetTime: 1_750_018_000 },
        ],
      },
    },
    NOW,
  );
  assert.equal(result.supported, true);
  assert.deepEqual(
    result.windows.map((window) => [window.kind, window.usedPercent, window.resetAt]),
    [
      ["weekly", 30, 1_750_060_000_000],
      ["5h", 45, 1_750_018_000_000],
    ],
  );
});

test("zhipu quota treats untagged token limits as 5h then weekly by reset order", () => {
  const result = parseZhipuQuotaResponse(
    {
      success: true,
      code: 200,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", percentage: 10, nextResetTime: 1_750_060_000 },
          { type: "TOKENS_LIMIT", percentage: 80, nextResetTime: 1_750_018_000 },
        ],
      },
    },
    NOW,
  );
  assert.deepEqual(
    result.windows.map((window) => [window.kind, window.usedPercent]),
    [
      ["5h", 80],
      ["weekly", 10],
    ],
  );
});

test("zhipu quota appends the monthly MCP counter and rejects failed payloads", () => {
  const result = parseZhipuQuotaResponse(
    {
      success: true,
      code: 200,
      data: {
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, percentage: 12 },
          { type: "TIME_LIMIT", remaining: 30, usage: 100 },
        ],
      },
    },
    NOW,
  );
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[1].kind, "mcp_monthly");
  assert.equal(result.windows[1].remainingPercent, 30);
  assert.equal(result.windows[1].usedPercent, 70);

  const failed = parseZhipuQuotaResponse({ success: false, code: 401, msg: "bad key" }, NOW);
  assert.equal(failed.supported, false);
  assert.equal(failed.windows.length, 0);
  assert.match(failed.message, /bad key/);
});

// ===== DeepSeek =====

test("deepseek balance prefers CNY and derives the remaining share from the denominator", () => {
  const result = parseDeepSeekBalanceResponse(
    {
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "5.00", granted_balance: "0", topped_up_balance: "10.00" },
        { currency: "CNY", total_balance: "40.00", granted_balance: "10.00", topped_up_balance: "90.00" },
      ],
    },
    NOW,
  );
  assert.equal(result.supported, true);
  assert.equal(result.windows.length, 1);
  const balance = result.windows[0];
  assert.equal(balance.kind, "balance");
  assert.equal(balance.remainingLabel, "¥40.00");
  assert.equal(balance.remainingPercent, 40);
  assert.equal(balance.usedPercent, 60);
  assert.equal(balance.showProgress, true);
});

test("deepseek balance without a denominator stays unprogressed and honors availability", () => {
  const noDenominator = parseDeepSeekBalanceResponse(
    { balance_infos: [{ currency: "CNY", total_balance: "12.34" }] },
    NOW,
  );
  assert.equal(noDenominator.windows[0].showProgress, false);
  assert.equal(noDenominator.windows[0].remainingPercent, 100);

  const unavailable = parseDeepSeekBalanceResponse(
    { is_available: false, balance_infos: [{ currency: "CNY", total_balance: "12.34" }] },
    NOW,
  );
  assert.equal(unavailable.windows[0].remainingPercent, 0);
  assert.match(unavailable.message, /unavailable/);

  assert.equal(parseDeepSeekBalanceResponse({ balance_infos: [] }, NOW).supported, false);
  assert.equal(
    parseDeepSeekBalanceResponse({ error: { message: "invalid key" } }, NOW).supported,
    false,
  );
});

// ===== Kimi =====

test("kimi quota reads the weekly summary and per-window limits", () => {
  const result = parseKimiQuotaResponse(
    {
      usage: { remaining: 88, used: 12, resetTime: "2026-01-19T00:00:00Z" },
      limits: [
        {
          window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
          detail: { remaining: 70, used: 30, resetTime: "2026-01-15T10:00:00Z" },
        },
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { remaining: 95, used: 5 },
        },
        {
          window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
          detail: { remaining: 60, used: 40, resetTime: "2026-01-18T00:00:00Z" },
        },
        {
          window: { duration: 1, timeUnit: "TIME_UNIT_MONTH" },
          detail: { remaining: 50, used: 50 },
        },
      ],
    },
    NOW,
  );
  assert.equal(result.supported, true);
  assert.deepEqual(
    result.windows.map((window) => [window.kind, window.remainingPercent]),
    [
      ["weekly", 88],
      ["5h", 70],
      ["5h", 95],
      ["days", 60],
      ["months", 50],
    ],
  );
  const week = result.windows[3];
  assert.equal(week.windowSeconds, 7 * 86_400);
  assert.equal(week.resetAt, Date.parse("2026-01-18T00:00:00Z"));
  assert.equal(result.windows[4].windowSeconds, 30 * 86_400);
});

test("kimi quota rejects error codes and missing summaries", () => {
  assert.equal(parseKimiQuotaResponse({ code: "401" }, NOW).supported, false);
  assert.equal(parseKimiQuotaResponse({}, NOW).supported, false);
});

// ===== MiniMax =====

test("minimax quota reads the interval window and optional weekly window", () => {
  const result = parseMiniMaxQuotaResponse(
    {
      base_resp: { status_code: 0 },
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 55.6,
          end_time: 1_750_018_000,
          current_weekly_total_count: 100,
          current_weekly_remaining_percent: 80,
          weekly_end_time: 1_750_060_000,
        },
      ],
    },
    NOW,
  );
  assert.equal(result.supported, true);
  assert.deepEqual(
    result.windows.map((window) => [window.kind, window.usedPercent, window.resetAt]),
    [
      ["5h", 44, 1_750_018_000_000],
      ["weekly", 20, 1_750_060_000_000],
    ],
  );
});

test("minimax quota omits the weekly window when unbounded and rejects errors", () => {
  const noWeekly = parseMiniMaxQuotaResponse(
    {
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: "general", current_interval_remaining_percent: 90 }],
    },
    NOW,
  );
  assert.deepEqual(noWeekly.windows.map((window) => window.kind), ["5h"]);

  const rejected = parseMiniMaxQuotaResponse(
    { base_resp: { status_code: 1004, status_msg: "no plan" } },
    NOW,
  );
  assert.equal(rejected.supported, false);
  assert.match(rejected.message, /no plan/);
});

// ===== Codex =====

test("codex quota maps primary and secondary windows onto 5h and weekly", () => {
  const result = parseCodexQuotaResponse(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 18_000,
          reset_after_seconds: 1_800,
        },
        secondary_window: {
          used_percent: 7,
          limit_window_seconds: 604_800,
          reset_at: 1_750_060_000,
        },
      },
    },
    NOW,
  );
  assert.equal(result.supported, true);
  assert.equal(result.planName, "ChatGPT Pro (Codex)");
  assert.deepEqual(
    result.windows.map((window) => [window.kind, window.usedPercent, window.resetAt]),
    [
      ["5h", 42, NOW + 1_800_000],
      ["weekly", 7, 1_750_060_000_000],
    ],
  );
  assert.equal(result.windows[0].windowSeconds, 18_000);
});

test("codex quota labels nonstandard windows by duration and tolerates a missing plan", () => {
  const result = parseCodexQuotaResponse(
    {
      rate_limit: {
        primary_window: { used_percent: 100, limit_window_seconds: 16200 },
        secondary_window: { used_percent: 0, limit_window_seconds: 172_800 },
      },
    },
    NOW,
  );
  assert.equal(result.planName, "ChatGPT (Codex)");
  assert.equal(result.windows[0].kind, "minutes");
  assert.equal(result.windows[1].kind, "days");

  assert.equal(parseCodexQuotaResponse({ rate_limit: {} }, NOW).supported, false);
});
