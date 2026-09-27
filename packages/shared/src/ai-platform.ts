/** Product routing policy, not a user-selectable endpoint preset. */
export const AI_PLATFORM_VENDOR_KEY = "ai-aggregation-platform";
export const AI_PLATFORM_NAME = "AI Aggregation Platform";
export const AI_PLATFORM_ORIGIN = "https://ai.yykkj.com";
export const AI_PLATFORM_BASE_URL = `${AI_PLATFORM_ORIGIN}/v1`;
export const AI_PLATFORM_WALLET_URL = `${AI_PLATFORM_ORIGIN}/wallet`;
export const AI_PLATFORM_API_STYLES = ["chat_completions", "responses", "anthropic_messages"] as const;

export type PlatformProvider = {
  vendorKey?: string;
  baseUrl?: string;
  authKind?: string;
  apiStyle?: string;
  headers?: Record<string, string>;
  extensionAgentKey?: string;
  ownerPluginId?: string | null;
};

export function isAIPlatformProvider(provider: PlatformProvider): boolean {
  if (!provider || typeof provider !== "object" || typeof provider.baseUrl !== "string") return false;
  return provider.vendorKey === AI_PLATFORM_VENDOR_KEY &&
    provider.baseUrl?.replace(/\/+$/, "") === AI_PLATFORM_BASE_URL &&
    (provider.authKind === "api_key" || provider.authKind === "api_key_and_base_url") &&
    !provider.extensionAgentKey && !provider.ownerPluginId &&
    (!provider.apiStyle || AI_PLATFORM_API_STYLES.some((style) => style === provider.apiStyle)) &&
    !Object.keys(provider.headers ?? {}).some((name) =>
      /^(authorization|x-api-key|api-key|host|cookie|proxy-authorization)$/i.test(name));
}

export function assertAIPlatformProvider(provider: PlatformProvider): void {
  if (!isAIPlatformProvider(provider)) {
    throw Object.assign(new Error(
      "This edition only supports AI Aggregation Platform. Register at https://ai.yykkj.com, recharge, create an API key, and configure the platform service in Settings > Models. Existing other-provider data is preserved but cannot be used here.",
    ), { errorCode: "PLATFORM_PROVIDER_REQUIRED" });
  }
}

/** Applied to each authenticated model request, including redirects. */
export function assertAIPlatformRequestUrl(value: string): void {
  const url = new URL(value);
  if (url.origin !== AI_PLATFORM_ORIGIN || url.username || url.password ||
    !url.pathname.startsWith("/v1/") || url.hash) {
    throw Object.assign(new Error("Model requests must use https://ai.yykkj.com/v1/."), {
      errorCode: "PLATFORM_ENDPOINT_REQUIRED",
    });
  }
}

export type PlatformTokenUsage = {
  totalGranted: number;
  totalUsed: number;
  totalAvailable: number;
  unlimited: boolean;
  expiresAt?: number;
  unit: "USD" | "quota";
};

export const PLATFORM_MEDIA_TIMEOUT_MS = 20 * 60 * 1000;
