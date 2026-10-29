/** Shared public types grouped by the owning application domain. */
import type { ModelBinding, ThinkingLevel } from "./models.js";

export const OAUTH_AUTH_KIND = "oauth";

export type ProviderPublic = {
  id: string;
  name: string;
  vendorKey: string;
  type: "native" | "openai_compatible" | "custom";
  protocol: string;
  enabled: boolean;
  baseUrl?: string;
  authKind: string;
  /** True when the provider holds an API key **or** a vendor-account login. */
  hasSecret: boolean;
  /** True when a vendor-account OAuth credential is stored. */
  hasOauth?: boolean;
  /** Non-secret label for the signed-in account; never carries a token. */
  oauthAccountLabel?: string;
  /**
   * Optional outbound HTTP headers. Empty/absent keeps adapter defaults
   * (pi-ai / `claude-cli` / OpenCode). Not a secret; Authorization and
   * other reserved keys are rejected.
   */
  headers?: Record<string, string>;
  /** Per-model settings selected in the provider dialog. */
  models: ModelBinding[];
  /** @deprecated Use `models[0]?.id`; retained for older runtime consumers. */
  defaultModelId?: string;
  apiStyle?: string;
  /** Effective capability for the provider's current default model. */
  supportsReasoning: boolean;
  /** Effective image-input capability for the provider's current default model. */
  supportsVision?: boolean;
  supportedThinkingLevels: ThinkingLevel[];
  /** Model context window override in tokens (runtime default when absent). */
  contextWindow?: number;
  /** Max output tokens override (runtime default when absent). */
  maxOutputTokens?: number;
  /** Sampling temperature override (provider default when absent). */
  temperature?: number;
  /**
   * Owning plugin id when the row came from `contributes.providers`. Absent for
   * a row the user created. A plugin-owned row is read-only in Settings: the
   * plugin refreshes it on every load, and `providers.update` /
   * `providers.delete` refuse it.
   */
  ownerPluginId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderCreateInput = {
  name: string;
  vendorKey?: string;
  type?: "native" | "openai_compatible" | "custom";
  protocol?: string;
  baseUrl?: string;
  authKind?: string;
  models?: ModelBinding[];
  /** @deprecated Use `models[0]?.id`; retained for older callers. */
  defaultModelId?: string;
  secretValue?: string;
  apiStyle?: string;
  /**
   * Non-secret label for the signed-in vendor account. Account removal deletes
   * the owning provider row instead of clearing only this label.
   */
  oauthAccountLabel?: string;
  /**
   * Optional outbound HTTP headers. On update, `{}` clears the stored map;
   * omit the field to leave it unchanged.
   */
  headers?: Record<string, string>;
  /** Explicit override for custom model catalogs. */
  supportsReasoning?: boolean;
  /**
   * Optional sparse override for custom/compatible models.
   * Values are canonical ThinkingLevel entries such as ["off","high"].
   * When omitted, capability resolution falls back to catalog/default sets.
   */
  supportedThinkingLevels?: ThinkingLevel[];
  /** Context window override in tokens; on update, 0 clears the override. */
  contextWindow?: number;
  /** Max output tokens override; on update, 0 clears the override. */
  maxOutputTokens?: number;
  /** Sampling temperature override; on update, 0 clears the override. */
  temperature?: number;
};

export type ProviderUpdateInput = Partial<ProviderCreateInput> & {
  id: string;
  enabled?: boolean;
};

/** One locally configured account for a vendor OAuth provider. */
export type OAuthAccount = {
  /** Provider row that owns this account's encrypted OAuth grant. */
  providerId: string;
  /** Non-secret account label, when the vendor exposes one. */
  accountLabel?: string;
  /** False for an orphaned row whose credential has already been removed. */
  connected: boolean;
};

/**
 * A vendor whose subscription account can be signed into instead of pasting an
 * API key. Derived from the runtime's built-in provider catalog, never a
 * hardcoded list. A vendor can own multiple independent local accounts.
 */
export type OAuthVendor = {
  /** Vendor id in the model runtime, e.g. "anthropic", "github-copilot". */
  vendorId: string;
  name: string;
  /** Vendor-supplied call to action, e.g. "Sign in with Claude Pro/Max". */
  loginLabel?: string;
  /** Whether access is backed by a paid subscription rather than usage credit. */
  isSubscription: boolean;
  /** Every local provider row created for this vendor. */
  accounts: OAuthAccount[];
};

export type OAuthPromptOption = {
  id: string;
  label: string;
  description?: string;
};

/** One question the vendor's login flow needs answered before it can finish. */
export type OAuthPromptRequest = {
  promptId: string;
  type: "text" | "secret" | "select" | "manual_code";
  /** Plain text prompts may accept an empty value as a vendor-defined default. */
  message: string;
  placeholder?: string;
  options?: OAuthPromptOption[];
};

/**
 * Progress of one login attempt, pushed to the renderer. Carries nothing
 * secret: tokens stay in the main process.
 */
export type OAuthLoginEvent = {
  loginId: string;
  vendorId: string;
} & (
  | { kind: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | {
      kind: "authUrl";
      url: string;
      instructions?: string;
      /** False when the browser could not be launched and the user must copy the link. */
      opened: boolean;
    }
  | {
      kind: "deviceCode";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { kind: "progress"; message: string }
  | { kind: "prompt"; request: OAuthPromptRequest }
  /** The flow resolved a prompt on its own — e.g. the callback beat the paste box. */
  | { kind: "promptCancelled"; promptId: string }
  | { kind: "done"; providerId: string; accountLabel?: string }
  | { kind: "error"; message: string; code?: "PLUGIN_OAUTH_FAILED" }
  | { kind: "cancelled" }
);

export type OAuthStartResult = {
  loginId: string;
};

export type OAuthRespondInput = {
  loginId: string;
  promptId: string;
  /** Absent cancels the prompt, which aborts the login flow. */
  value?: string;
};

/**
 * One rolling usage window of a subscription coding plan (GLM Coding Plan,
 * Kimi For Coding, MiniMax Token Plan, ChatGPT Codex, ...).
 *
 * The kind drives the renderer's localized label; the main process never
 * ships display strings, so every locale renders the same payload.
 */
export type ProviderPlanQuotaWindowKind =
  /** The vendor's primary rolling window (Zhipu unit=3, Codex 5h, MiniMax interval). */
  | "5h"
  /** The vendor's weekly window. */
  | "weekly"
  /** Zhipu monthly MCP call quota. */
  | "mcp_monthly"
  /** DeepSeek prepaid balance; `remainingLabel` carries the amount. */
  | "balance"
  /** GitHub-Copilot-shaped buckets kept for payload stability. */
  | "premium"
  | "chat"
  | "completions"
  | "billing"
  /** A window whose length is only known at runtime; `windowSeconds` scales the label. */
  | "hours"
  | "days"
  | "minutes"
  | "months"
  | "custom";

export type ProviderPlanQuotaWindow = {
  kind: ProviderPlanQuotaWindowKind;
  /** Window length in seconds; present when the vendor states one (Codex, Kimi). */
  windowSeconds?: number;
  /** Consumed share of the window, 0-100. */
  usedPercent: number;
  /** Remaining share; defaults to `100 - usedPercent` when absent. */
  remainingPercent?: number;
  /** Vendor-formatted remaining value for non-percent quotas (e.g. "$4.20"). */
  remainingLabel?: string;
  /** False hides the progress bar for quotas that have no meaningful percent. */
  showProgress?: boolean;
  /** Epoch ms when the window resets; absent when the vendor does not say. */
  resetAt?: number;
};

/** Result of the `providersPlanQuota` IPC call. Secrets never cross this boundary. */
export type ProviderPlanQuotaResult = {
  supported: boolean;
  /** Localized by the renderer from the plan tier when the vendor reports one. */
  planName?: string;
  windows: ProviderPlanQuotaWindow[];
  updatedAt: number;
  /**
   * Why the quota is unavailable. Diagnostic English wording from the vendor
   * call; the renderer decides what, if anything, to show the user.
   */
  message?: string;
};

/** Move one provider relative to another; applies atomically to the current host list. */
export type ProviderReorderInput = {
  id: string;
  targetId: string;
  placement: "before" | "after";
};
