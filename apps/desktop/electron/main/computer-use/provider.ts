import type { RuntimeProviderConfig } from "@pi-desktop/agent-runtime";
import type { ComputerModelBinding, ProviderPublic } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";

/**
 * Resolve the user's computer-use model into a provider config.
 *
 * It is deliberately its own binding rather than the conversation model
 * (ADR 0340 §9), so it is resolved the way image generation resolves its
 * binding: from the provider row the user picked, with its own secret. A
 * binding whose provider is gone, disabled, or missing its key resolves to
 * `null`, and the tool reports an unconfigured feature instead of quietly
 * running on the chat model.
 *
 * The loop always asks with thinking off, so no reasoning capability is
 * claimed here; pi-ai supplies the model's own metadata.
 */
export async function resolveComputerUseProvider(input: {
  host: Pick<HostProcess, "call">;
  binding: ComputerModelBinding;
  resolveAuth?: (providerId: string) => Promise<unknown>;
}): Promise<RuntimeProviderConfig | null> {
  const { provider } = await input.host.call<{ provider?: ProviderPublic }>("providers.get", {
    id: input.binding.providerId,
  });
  if (!provider?.enabled) return null;

  const needsSecret = provider.authKind !== "oauth" && provider.authKind !== "none";
  let apiKey = "";
  if (needsSecret) {
    const { value } = await input.host.call<{ value?: string }>("providers.getSecret", {
      id: provider.id,
    });
    if (!value) return null;
    apiKey = value;
  }

  return {
    id: provider.id,
    name: provider.name,
    ...(provider.vendorKey ? { vendorKey: provider.vendorKey } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    modelId: input.binding.modelId,
    apiKey,
    ...(provider.authKind ? { authKind: provider.authKind } : {}),
    ...(provider.apiStyle ? { apiStyle: provider.apiStyle } : {}),
    supportsReasoning: false,
    supportedThinkingLevels: ["off"],
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(provider.authKind === "oauth" && input.resolveAuth
      ? { resolveAuth: () => input.resolveAuth!(provider.id) as never }
      : {}),
  } as RuntimeProviderConfig;
}
