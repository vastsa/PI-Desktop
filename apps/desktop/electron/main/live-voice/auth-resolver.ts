import { Buffer } from "node:buffer";
import { OAUTH_AUTH_KIND, type LiveBinding, type ProviderPublic } from "@pi-desktop/shared";
import type { VendorOAuth } from "../oauth";
import type { LiveResolvedAuth } from "./types";

export type LiveAuthResolverDeps = {
  callHost: <T>(method: string, params?: unknown) => Promise<T>;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">;
};

export type LiveProviderRecord = {
  provider: ProviderPublic;
  secret?: string;
};

export function codexAccountIdFromJwt(accessToken: string): string | null {
  if (accessToken.length > 16_384) return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1] || parts[1].length > 12_000) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const claim = (decoded as Record<string, unknown>)["https://api.openai.com/auth"];
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) return null;
    const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 && accountId.length <= 256 ? accountId : null;
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | null {
  if (!headers) return null;
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bearerToken(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const match = value.trim().match(/^Bearer\s+(.+)$/i);
  return (match?.[1] ?? value).trim() || null;
}

export function resolveCodexRequestAuth(auth: {
  apiKey?: string;
  headers?: Record<string, unknown>;
}): { accessToken: string; accountId: string } {
  const fromApiKey = bearerToken(auth.apiKey);
  const fromHeader = bearerToken(headerValue(auth.headers, "authorization") ?? undefined);
  if (fromApiKey && fromHeader && fromApiKey !== fromHeader) {
    throw Object.assign(new Error("Codex authentication sources disagree"), { errorCode: "LIVE_AUTH_REQUIRED" });
  }
  const accessToken = fromApiKey ?? fromHeader;
  if (!accessToken) throw Object.assign(new Error("Codex account credentials are unavailable"), { errorCode: "LIVE_AUTH_REQUIRED" });

  const headerAccountId = headerValue(auth.headers, "chatgpt-account-id");
  const tokenAccountId = codexAccountIdFromJwt(accessToken);
  if (headerAccountId && tokenAccountId && headerAccountId !== tokenAccountId) {
    throw Object.assign(new Error("Codex account metadata is inconsistent"), { errorCode: "LIVE_ACCOUNT_ID_MISSING" });
  }
  const accountId = headerAccountId ?? tokenAccountId;
  if (!accountId) throw Object.assign(new Error("Codex account metadata is unavailable"), { errorCode: "LIVE_ACCOUNT_ID_MISSING" });
  return { accessToken, accountId };
}

export class LiveAuthResolver {
  constructor(private readonly deps: LiveAuthResolverDeps) {}

  async provider(providerId: string): Promise<LiveProviderRecord | null> {
    const result = await this.deps.callHost<{ provider?: ProviderPublic }>("providers.get", { id: providerId });
    return result.provider ? { provider: result.provider } : null;
  }

  async resolve(binding: LiveBinding): Promise<{ provider: ProviderPublic; auth: LiveResolvedAuth }> {
    const initial = await this.provider(binding.providerId);
    if (!initial?.provider || !initial.provider.enabled) {
      throw Object.assign(new Error("The selected Provider is unavailable"), { errorCode: "LIVE_PROVIDER_NOT_FOUND" });
    }
    const provider = initial.provider;
    if (binding.adapterId === "codex-live") {
      if (provider.authKind !== OAUTH_AUTH_KIND || provider.vendorKey !== "openai-codex") {
        throw Object.assign(new Error("Codex Live requires a signed-in Codex account"), { errorCode: "LIVE_AUTH_KIND_UNSUPPORTED" });
      }
      let requestAuth: { accessToken: string; accountId: string };
      try {
        requestAuth = resolveCodexRequestAuth(await this.deps.vendorOAuth.resolveAuth(binding.providerId));
      } catch (error) {
        if (error && typeof error === "object" && "errorCode" in error) throw error;
        throw Object.assign(new Error("Codex account credentials could not be resolved"), { errorCode: "LIVE_AUTH_REQUIRED", cause: error });
      }
      await this.assertStillSelected(binding, provider);
      return { provider, auth: { kind: "codex-oauth", ...requestAuth } };
    }

    if (provider.authKind === OAUTH_AUTH_KIND) {
      throw Object.assign(new Error("Live API-key adapters do not accept OAuth credentials"), { errorCode: "LIVE_AUTH_KIND_UNSUPPORTED" });
    }
    if (!provider.hasSecret) throw Object.assign(new Error("The selected Provider has no API key"), { errorCode: "LIVE_AUTH_REQUIRED" });
    if (binding.adapterId === "gemini-live" && (provider.vendorKey !== "google" || provider.apiStyle !== "google_generative_ai")) {
      throw Object.assign(new Error("Gemini Live requires a Google Generative AI API-key Provider"), { errorCode: "LIVE_AUTH_KIND_UNSUPPORTED" });
    }
    const secret = await this.deps.callHost<{ value?: string }>("providers.getSecret", { id: binding.providerId });
    const apiKey = typeof secret.value === "string" ? secret.value.trim() : "";
    if (!apiKey) throw Object.assign(new Error("The selected Provider API key is missing"), { errorCode: "LIVE_AUTH_REQUIRED" });
    await this.assertStillSelected(binding, provider);
    const baseUrl = provider.baseUrl?.trim() ?? "";
    if (binding.adapterId === "openai-realtime" && !baseUrl) {
      throw Object.assign(new Error("The selected Provider has no endpoint URL"), { errorCode: "LIVE_PROVIDER_NOT_FOUND" });
    }
    return { provider, auth: { kind: "api-key", apiKey, baseUrl } };
  }

  private async assertStillSelected(binding: LiveBinding, original: ProviderPublic): Promise<void> {
    const current = await this.provider(binding.providerId);
    if (!current?.provider?.enabled || current.provider.id !== original.id || current.provider.authKind !== original.authKind || current.provider.vendorKey !== original.vendorKey) {
      throw Object.assign(new Error("The selected Provider changed during authentication"), { errorCode: "LIVE_PROVIDER_NOT_FOUND" });
    }
    if (binding.adapterId === "openai-realtime" && current.provider.baseUrl !== original.baseUrl) {
      throw Object.assign(new Error("The selected Provider endpoint changed during authentication"), { errorCode: "LIVE_PROVIDER_NOT_FOUND" });
    }
  }
}
