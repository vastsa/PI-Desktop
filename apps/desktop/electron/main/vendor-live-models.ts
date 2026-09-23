/**
 * Live model lists for signed-in vendor accounts.
 *
 * Each vendor is probed on the endpoint that actually publishes the account's
 * models. pi-ai's pinned catalog is not consulted here; callers use it only
 * when this module cannot return a list.
 */

const LIVE_MODELS_TIMEOUT_MS = 8_000;
const MAX_RETRY_DELAY_MS = 1_000;

const NON_CONVERSATION_MODEL =
  /(?:^|[-_/])(?:imagine|image|video|tts|stt|speech|embed(?:ding)?|whisper|aurora|flux|realtime|moderation)(?:$|[-_/])/i;

const SINGLE_WIRE_API: Record<string, string> = {
  anthropic: "anthropic-messages",
  "kimi-coding": "anthropic-messages",
  meta: "openai-responses",
  "openai-codex": "openai-codex-responses",
  xai: "openai-responses",
};

const DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: "https://api.anthropic.com",
  "github-copilot": "https://api.individual.githubcopilot.com",
  "kimi-coding": "https://api.kimi.com/coding",
  meta: "https://api.meta.ai/v1",
  "openai-codex": "https://chatgpt.com/backend-api",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
};

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
  "X-GitHub-Api-Version": "2026-06-01",
} as const;

const COPILOT_INDIVIDUAL_BASE = "https://api.individual.githubcopilot.com";
const XAI_SIBLING_ORDER = ["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3"] as const;
const TIER_TOKENS = new Set([
  "astra",
  "fable",
  "flash",
  "haiku",
  "luna",
  "mini",
  "nano",
  "opus",
  "pro",
  "sol",
  "sonnet",
  "spark",
  "terra",
]);

export type VendorModelListRequest = {
  url: string;
  headers: Record<string, string>;
  /** Host stored on a model the pin does not know yet. */
  accountBaseUrl: string;
  allowPolicyFallback: boolean;
};

export type PinnedWire = {
  id: string;
  api: string;
  baseUrl: string;
};

export function isConversationModelId(modelId: string): boolean {
  const id = modelId.trim();
  return id.length > 0 && !NON_CONVERSATION_MODEL.test(id);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimBase(url: string | undefined, fallback: string): string {
  const value = (url?.trim() || fallback).replace(/\/+$/, "");
  return value;
}

function chatgptAccountId(token: string): string | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
      ["https://api.openai.com/auth"]?: { chatgpt_account_id?: unknown };
    };
    const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The account's model-list request, or undefined when this vendor has none. */
export function vendorModelListRequest(input: {
  vendorId: string;
  apiKey?: string;
  baseUrl?: string;
}): VendorModelListRequest | undefined {
  const apiKey = input.apiKey?.trim() ?? "";
  if (!apiKey) return undefined;
  const fallback = DEFAULT_BASE_URL[input.vendorId];
  if (!fallback && input.vendorId !== "github-copilot") return undefined;
  const base = trimBase(input.baseUrl, fallback ?? COPILOT_INDIVIDUAL_BASE);
  const bearer = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

  if (input.vendorId === "openai-codex") {
    const accountId = chatgptAccountId(apiKey);
    if (!accountId) return undefined;
    return {
      url: `${base}/codex/models`,
      accountBaseUrl: base,
      allowPolicyFallback: false,
      headers: {
        ...bearer,
        "chatgpt-account-id": accountId,
        originator: "pi",
      },
    };
  }

  if (input.vendorId === "github-copilot") {
    return {
      url: `${base}/models`,
      accountBaseUrl: base,
      allowPolicyFallback: base === COPILOT_INDIVIDUAL_BASE,
      headers: { ...bearer, ...COPILOT_HEADERS },
    };
  }

  if (input.vendorId === "anthropic") {
    const root = base.endsWith("/v1") ? base : `${base}/v1`;
    const oauth = apiKey.includes("sk-ant-oat");
    return {
      url: `${root}/models?limit=1000`,
      accountBaseUrl: base.endsWith("/v1") ? base.slice(0, -3) : base,
      allowPolicyFallback: false,
      headers: oauth
        ? {
            ...bearer,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
            "x-app": "cli",
            "user-agent": "claude-cli/2.1.251",
          }
        : {
            Accept: "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
    };
  }

  if (input.vendorId === "kimi-coding") {
    const root = base.endsWith("/v1") ? base : `${base}/v1`;
    return {
      url: `${root}/models?limit=1000`,
      accountBaseUrl: base.endsWith("/v1") ? base.slice(0, -3) : base,
      allowPolicyFallback: false,
      headers: { ...bearer, "anthropic-version": "2023-06-01" },
    };
  }

  if (
    input.vendorId === "xai" ||
    input.vendorId === "meta" ||
    input.vendorId === "openrouter"
  ) {
    return {
      url: `${base}/models`,
      accountBaseUrl: base,
      allowPolicyFallback: false,
      headers: bearer,
    };
  }

  return undefined;
}

function conversationIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const modelId = id.trim();
    if (!isConversationModelId(modelId) || seen.has(modelId)) continue;
    seen.add(modelId);
    out.push(modelId);
  }
  return out;
}

function parseDataIds(body: unknown): string[] | null {
  const record = asRecord(body);
  const data = Array.isArray(record?.data)
    ? record.data
    : Array.isArray(body)
      ? body
      : null;
  if (!data) return null;
  return conversationIds(
    data.flatMap((entry) => {
      const id = asRecord(entry)?.id;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

function parseCodexIds(body: unknown): string[] | null {
  const models = asRecord(body)?.models;
  if (!Array.isArray(models)) return null;
  return conversationIds(
    models.flatMap((entry) => {
      const item = asRecord(entry);
      const slug = item?.slug ?? item?.id;
      if (!item || typeof slug !== "string") return [];
      const visibility = item.visibility;
      if (visibility === "hide" || visibility === "hidden") return [];
      return [slug];
    }),
  );
}

function parseCopilotIds(body: unknown, allowPolicyFallback: boolean): string[] | null {
  const data = asRecord(body)?.data;
  if (!Array.isArray(data)) return null;
  const accountModels = data.flatMap((entry) => {
    const item = asRecord(entry);
    const id = item?.id;
    if (!item || typeof id !== "string") return [];
    const supports = asRecord(asRecord(item.capabilities)?.supports);
    if (supports?.tool_calls === false) return [];
    const policyState = asRecord(item.policy)?.state;
    return [{
      id,
      pickerEnabled: item.model_picker_enabled === true,
      policyState: typeof policyState === "string" ? policyState : undefined,
    }];
  });
  const pickerIds = accountModels
    .filter((model) => model.pickerEnabled && model.policyState !== "disabled")
    .map((model) => model.id);
  const available = pickerIds.length > 0 || !allowPolicyFallback
    ? pickerIds
    : accountModels
        .filter((model) => model.policyState === "enabled")
        .map((model) => model.id);
  return conversationIds(available);
}

/** Parsed chat-model ids, or null when the payload is not that vendor's list. */
export function parseVendorModelIds(
  vendorId: string,
  body: unknown,
  allowPolicyFallback = false,
): string[] | null {
  if (vendorId === "github-copilot") return parseCopilotIds(body, allowPolicyFallback);
  if (vendorId === "openai-codex") return parseCodexIds(body);
  return parseDataIds(body);
}

export function familyKey(modelId: string): string {
  const slash = modelId.indexOf("/");
  const head = slash > 0 ? modelId.slice(0, slash) : modelId.split("-")[0] ?? "";
  return head.trim().toLowerCase();
}

/**
 * Wire API for an id the pin does not contain.
 * A vendor with one wire API uses that. Copilot and OpenRouter only keep an
 * id whose family already maps to exactly one wire API in the pin.
 */
export function wireForLiveModel(
  vendorId: string,
  modelId: string,
  pinned: readonly PinnedWire[],
  accountBaseUrl: string,
): { api: string; baseUrl: string } | undefined {
  const single = SINGLE_WIRE_API[vendorId];
  if (single) return { api: single, baseUrl: accountBaseUrl };
  const family = familyKey(modelId);
  if (!family) return undefined;
  const same = pinned.filter((model) => familyKey(model.id) === family);
  const apis = new Set(same.map((model) => model.api));
  if (apis.size !== 1) return undefined;
  return {
    api: [...apis][0] ?? "",
    baseUrl: accountBaseUrl || same[0]?.baseUrl || "",
  };
}

function versionKey(id: string): number[] {
  return (id.match(/\d+(?:\.\d+)*/g) ?? []).flatMap((part) =>
    part.split(".").map((piece) => Number(piece)),
  );
}

function newerFirst(a: string, b: string): number {
  const left = versionKey(a);
  const right = versionKey(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return a.localeCompare(b);
}

function tierToken(modelId: string): string | undefined {
  return modelId
    .toLowerCase()
    .split(/[-/]/)
    .find((part) => TIER_TOKENS.has(part));
}

/**
 * Pinned id whose limits a just-released model may inherit.
 * xAI keeps an explicit newest-first order. Every other vendor inherits only
 * from the same tier (luna, sonnet, …), never from a different flagship.
 */
export function pinnedSiblingId(
  vendorId: string,
  modelId: string,
  pinnedIds: readonly string[],
): string | undefined {
  if (vendorId === "xai" && familyKey(modelId) === "grok") {
    const preferred = XAI_SIBLING_ORDER.find((id) => pinnedIds.includes(id));
    if (preferred) return preferred;
  }
  const tier = tierToken(modelId);
  if (!tier) return undefined;
  const family = familyKey(modelId);
  const candidates = pinnedIds.filter(
    (id) => familyKey(id) === family && tierToken(id) === tier,
  );
  candidates.sort(newerFirst);
  return candidates[0];
}

function retryDelayMs(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return 500;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(delay) || delay < 0) return 500;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

/** GET the vendor model list. Retries one HTTP 429, then throws. */
export async function readVendorModelList(
  request: VendorModelListRequest,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let waitMs = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIVE_MODELS_TIMEOUT_MS);
    try {
      const response = await fetchImpl(request.url, {
        headers: request.headers,
        signal: controller.signal,
      });
      if (response.status === 429 && attempt === 0) {
        waitMs = retryDelayMs(response);
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        throw new Error(`model list request failed (${response.status})`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("model list request failed");
}
