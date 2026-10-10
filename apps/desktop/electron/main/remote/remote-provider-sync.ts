import {
  ErrorCodes, PROVIDER_SYNC_MAX_PROVIDERS, isSyncableProvider,
  parseProviderImportPayload, parseProviderImportSummary,
  type ProviderCreateInput, type ProviderImportPayload, type ProviderImportSummary,
  type ProviderPublic, type RemoteHostSshMetadata,
} from "@pi-desktop/shared";
import type { SshTarget, SshTransport } from "./ssh-transport.js";
import { sshTargetOf } from "./ssh-tunnel.js";

const IMPORT_COMMAND = 'node "$HOME/.pi-desktop/pi-host/current/pi-host.js" provider-import';
const OUTPUT_MAX_BYTES = 64 * 1024;
function invalid(): Error {
  return Object.assign(new Error("Provider selection cannot be synced"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}
function failed(): Error {
  return Object.assign(new Error("Remote provider import failed"), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
}
function createInputOf(provider: ProviderPublic): ProviderCreateInput {
  return {
    name: provider.name, vendorKey: provider.vendorKey, type: provider.type,
    protocol: provider.protocol, authKind: provider.authKind, models: provider.models,
    supportsReasoning: provider.supportsReasoning, supportedThinkingLevels: provider.supportedThinkingLevels,
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.defaultModelId !== undefined ? { defaultModelId: provider.defaultModelId } : {}),
    ...(provider.apiStyle !== undefined ? { apiStyle: provider.apiStyle } : {}),
    ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
    ...(provider.contextWindow !== undefined ? { contextWindow: provider.contextWindow } : {}),
    ...(provider.maxOutputTokens !== undefined ? { maxOutputTokens: provider.maxOutputTokens } : {}),
    ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
  };
}
export type BuildImportPayloadInput = {
  providers: ProviderPublic[];
  providerIds: string[];
  setDefault: boolean;
  getSecret: (providerId: string) => Promise<string | undefined>;
  localDefault?: { providerId?: string; modelId?: string };
};

/** Main-process only. Revalidates the explicit selection before reading any key. */
export async function buildImportPayload(input: BuildImportPayloadInput): Promise<ProviderImportPayload> {
  try {
    if (!Array.isArray(input.providerIds) || input.providerIds.length < 1 || input.providerIds.length > PROVIDER_SYNC_MAX_PROVIDERS || typeof input.setDefault !== "boolean") throw invalid();
    const ids = [...new Set(input.providerIds)];
    const selected = ids.map((id) => {
      const row = input.providers.find((provider) => provider.id === id);
      if (!row || !isSyncableProvider(row)) throw invalid();
      return structuredClone(row);
    });
    const local = input.localDefault ? { ...input.localDefault } : undefined;
    const payload: ProviderImportPayload = {
      version: 1, providers: selected.map((row) => ({ sourceId: row.id, input: createInputOf(row) })),
    };
    if (input.setDefault) {
      const chosen = selected.find((row) => row.id === local?.providerId) ?? selected[0]!;
      const modelId = chosen.id === local?.providerId && local.modelId !== undefined
        ? local.modelId : chosen.defaultModelId ?? chosen.models[0]?.id;
      if (!modelId || !chosen.models.some((model) => model.id === modelId)) throw invalid();
      payload.defaultModel = { sourceId: chosen.id, modelId };
    }
    for (const entry of payload.providers) {
      if (entry.input.authKind !== "none") entry.input.secretValue = await input.getSecret(entry.sourceId);
    }
    return parseProviderImportPayload(payload);
  } catch {
    // Secret-store failures can include sensitive diagnostics. No cause crosses IPC.
    throw invalid();
  }
}
export type ImportOverSshInput = {
  ssh: RemoteHostSshMetadata;
  sshSecret?: string;
  payload: ProviderImportPayload;
  buildTransport: (target: SshTarget) => SshTransport;
};

/** Only stdin carries the keys. Neither RACP nor a remote shell script sees them. */
export async function importProvidersOverSsh(input: ImportOverSshInput): Promise<ProviderImportSummary> {
  try {
    const payload = parseProviderImportPayload(input.payload);
    const transport = input.buildTransport(sshTargetOf(input.ssh, input.sshSecret));
    try {
      const result = await transport.execWithInput(IMPORT_COMMAND, JSON.stringify(payload), { timeoutMs: 60_000, maxOutputBytes: OUTPUT_MAX_BYTES });
      if (result.code !== 0 || Buffer.byteLength(result.stdout) > OUTPUT_MAX_BYTES) throw failed();
      const line = result.stdout.trim();
      if (!line.startsWith("PI_HOST_PROVIDERS ") || line.includes("\n")) throw failed();
      const summary = parseProviderImportSummary(JSON.parse(line.slice("PI_HOST_PROVIDERS ".length)));
      const ids = new Set(payload.providers.map((entry) => entry.sourceId));
      const entries = [...summary.imported, ...summary.skipped];
      if (entries.length !== ids.size || entries.some((entry) => !ids.has(entry.sourceId))
        || (summary.defaultSet && (!payload.defaultModel || !summary.imported.some((entry) => entry.sourceId === payload.defaultModel?.sourceId)))) throw failed();
      return summary;
    } finally {
      transport.dispose();
    }
  } catch {
    // SSH streams, parser errors and disposal failures may echo a key.
    throw failed();
  }
}
