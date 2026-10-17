import type { HostRpcPort } from "@pi-desktop/agent-host";
import type { AppSettings, ProviderPublic, RemoteHostSyncProvidersRequest, RemoteHostSyncProvidersResult } from "@pi-desktop/shared";
import type { RemoteHostRecord } from "./remote-host-registry.js";
import { sshMetadataOf } from "./remote-host-metadata.js";
import { buildImportPayload, importProvidersOverSsh } from "./remote-provider-sync.js";
import { createSystemSshTransport } from "./ssh-transport.js";

/** Explicit, SSH-only credential transfer. No provider/secret RACP operation exists. */
export async function syncRemoteProviders(
  input: RemoteHostSyncProvidersRequest,
  record: RemoteHostRecord,
  host: HostRpcPort,
): Promise<RemoteHostSyncProvidersResult> {
  const ssh = sshMetadataOf(record);
  if (!ssh || record.hostKey !== input.hostKey) {
    throw Object.assign(new Error("provider sync requires an SSH-paired host"), { errorCode: "CAPABILITY_UNAVAILABLE" });
  }
  const [{ providers }, settings] = await Promise.all([
    host.call<{ providers: ProviderPublic[] }>("providers.list", { includeDisabled: false }),
    host.call<AppSettings>("settings.get"),
  ]);
  const payload = await buildImportPayload({
    providers, providerIds: input.providerIds, setDefault: input.setDefault,
    getSecret: async (id: string) => (await host.call<{ value?: string }>("providers.getSecret", { id })).value,
    ...(settings.defaultProviderId && settings.defaultModelId
      ? { localDefault: { providerId: settings.defaultProviderId, modelId: settings.defaultModelId } } : {}),
  });
  return importProvidersOverSsh({ ssh, sshSecret: record.sshSecret, payload, buildTransport: createSystemSshTransport });
}
