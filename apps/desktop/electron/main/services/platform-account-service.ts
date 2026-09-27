import {
  AI_PLATFORM_ORIGIN,
  assertAIPlatformProvider,
  type PlatformTokenUsage,
  type ProviderPublic,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";

async function readPlatformJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`Platform account request failed (HTTP ${response.status})`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty platform response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) throw new Error("Platform account response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid platform response");
  return value as Record<string, unknown>;
}

/** Token allowance is not the user's wallet balance or proof of payment. */
export async function platformTokenUsage(
  host: Pick<HostProcess, "call">,
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformTokenUsage> {
  if (typeof providerId !== "string" || !providerId.trim()) throw new Error("Provider required");
  const { provider } = await host.call<{ provider?: ProviderPublic }>("providers.get", { id: providerId });
  if (!provider?.enabled) throw new Error("Platform provider unavailable");
  assertAIPlatformProvider(provider);
  const { value } = await host.call<{ value?: string }>("providers.getSecret", { id: providerId });
  if (!value) throw new Error("Configure a platform API key first");
  const signal = AbortSignal.timeout(15_000);
  const [usage, status] = await Promise.all([
    fetchImpl(`${AI_PLATFORM_ORIGIN}/api/usage/token/`, {
      headers: { Authorization: `Bearer ${value}` }, signal, redirect: "error",
    }).then(readPlatformJson),
    fetchImpl(`${AI_PLATFORM_ORIGIN}/api/status`, { signal, redirect: "error" })
      .then(readPlatformJson).catch(() => null),
  ]);
  if (usage.code !== true || !usage.data || typeof usage.data !== "object") {
    throw new Error("Platform did not return token usage");
  }
  const data = usage.data as Record<string, unknown>;
  const numbers = [data.total_granted, data.total_used, data.total_available];
  if (!numbers.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ||
    typeof data.unlimited_quota !== "boolean") throw new Error("Invalid platform quota response");
  const statusData = status?.success === true ? status.data as Record<string, unknown> | undefined : undefined;
  const unit = statusData?.quota_per_unit;
  const knownUnit = typeof unit === "number" && Number.isFinite(unit) && unit > 0 &&
    numbers.every((n) => Number.isFinite((n as number) / unit));
  const divisor = knownUnit ? unit : 1;
  return {
    totalGranted: (data.total_granted as number) / divisor,
    totalUsed: (data.total_used as number) / divisor,
    totalAvailable: (data.total_available as number) / divisor,
    unlimited: data.unlimited_quota,
    ...(typeof data.expires_at === "number" && Number.isSafeInteger(data.expires_at) && data.expires_at >= 0 ? { expiresAt: data.expires_at } : {}),
    unit: knownUnit ? "USD" : "quota",
  };
}
