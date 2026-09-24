/**
 * Copy local provider configs to a paired SSH host (D625). A freshly
 * bootstrapped host has no models, so every turn fails with
 * MODEL_NOT_CONFIGURED; this is the user's manual fix.
 *
 * The payload carries API keys, so it only travels as the stdin of
 * `pi-host provider-import` over the host's own SSH channel — never argv,
 * logs, or RACP. The remote CLI hands it to the running pi-host over its
 * owner-only admin socket, which writes through the running host-core.
 */
import {
  ErrorCodes,
  isSyncableProvider,
  PROVIDER_SYNC_MAX_PROVIDERS,
  type ProviderCreateInput,
  type ProviderImportPayload,
  type ProviderImportSummary,
  type ProviderPublic,
  type RemoteHostSshMetadata,
} from "@pi-desktop/shared";
import type { SshTarget, SshTransport } from "./ssh-transport.js";
import { sshTargetOf } from "./ssh-tunnel.js";

const IMPORT_TIMEOUT_MS = 60_000;
const IMPORT_COMMAND = 'node "$HOME/.pi-desktop/pi-host/current/pi-host.js" provider-import';

function fail(message: string, errorCode: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...(data ? { data } : {}) });
}

function createInputOf(provider: ProviderPublic, secretValue: string | undefined): ProviderCreateInput {
  return {
    name: provider.name,
    vendorKey: provider.vendorKey,
    type: provider.type,
    protocol: provider.protocol,
    authKind: provider.authKind,
    models: provider.models,
    supportedThinkingLevels: provider.supportedThinkingLevels,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiStyle ? { apiStyle: provider.apiStyle } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(provider.contextWindow ? { contextWindow: provider.contextWindow } : {}),
    ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
    ...(provider.temperature ? { temperature: provider.temperature } : {}),
    ...(secretValue ? { secretValue } : {}),
  };
}

export type BuildImportPayloadInput = {
  providers: ProviderPublic[];
  providerIds: string[];
  setDefault: boolean;
  getSecret: (providerId: string) => Promise<string | undefined>;
};

/**
 * The stdin document for `pi-host provider-import`. Every requested id must be
 * a syncable local provider; the renderer's list is a hint, not authority.
 */
export async function buildImportPayload(input: BuildImportPayloadInput): Promise<ProviderImportPayload> {
  const ids = [...new Set(input.providerIds)];
  if (ids.length === 0) throw fail("providerIds is required", ErrorCodes.INVALID_ARGUMENT);
  if (ids.length > PROVIDER_SYNC_MAX_PROVIDERS) {
    throw fail(`at most ${PROVIDER_SYNC_MAX_PROVIDERS} providers can be synced`, ErrorCodes.INVALID_ARGUMENT);
  }
  const byId = new Map(input.providers.map((provider) => [provider.id, provider]));
  const entries: ProviderImportPayload["providers"] = [];
  for (const id of ids) {
    const provider = byId.get(id);
    if (!provider || !isSyncableProvider(provider)) {
      throw fail("provider cannot be synced", ErrorCodes.INVALID_ARGUMENT, { providerId: id });
    }
    const secret = provider.hasSecret ? await input.getSecret(id) : undefined;
    if (provider.authKind !== "none" && !secret) {
      throw fail("provider has no stored key", ErrorCodes.INVALID_ARGUMENT, { providerId: id });
    }
    entries.push({ sourceId: id, input: createInputOf(provider, secret) });
  }
  const first = entries[0]!;
  const modelId = first.input.models?.[0]?.id ?? byId.get(first.sourceId)?.defaultModelId;
  return {
    version: 1,
    providers: entries,
    ...(input.setDefault && modelId ? { defaultModel: { sourceId: first.sourceId, modelId } } : {}),
  };
}

const MARKER_OK = "PI_HOST_PROVIDERS ";
const MARKER_FAILED = "PI_HOST_FAILED ";

/** Read the CLI's single result line; anything else is a host failure. */
export function parseImportOutput(stdout: string): ProviderImportSummary {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (line.startsWith(MARKER_FAILED)) {
      let code = "UNKNOWN";
      try {
        const parsed = JSON.parse(line.slice(MARKER_FAILED.length)) as { code?: unknown };
        if (typeof parsed.code === "string") code = parsed.code.slice(0, 64);
      } catch {
        // Keep the generic code; the raw line is not surfaced.
      }
      throw fail(`remote provider import failed: ${code}`, ErrorCodes.HOST_UNAVAILABLE, { code });
    }
    if (line.startsWith(MARKER_OK)) {
      const summary = JSON.parse(line.slice(MARKER_OK.length)) as ProviderImportSummary;
      if (!Array.isArray(summary?.imported) || !Array.isArray(summary?.skipped)) break;
      return {
        imported: summary.imported,
        skipped: summary.skipped,
        defaultSet: summary.defaultSet === true,
      };
    }
  }
  throw fail("the remote host gave no provider import result", ErrorCodes.HOST_UNAVAILABLE);
}

export type ImportOverSshInput = {
  ssh: RemoteHostSshMetadata;
  sshSecret?: string;
  payload: ProviderImportPayload;
  buildTransport: (target: SshTarget) => SshTransport;
};

export async function importProvidersOverSsh(input: ImportOverSshInput): Promise<ProviderImportSummary> {
  const transport = input.buildTransport(sshTargetOf(input.ssh, input.sshSecret));
  try {
    let stdout: string;
    try {
      stdout = (
        await transport.execWithInput(IMPORT_COMMAND, JSON.stringify(input.payload), {
          timeoutMs: IMPORT_TIMEOUT_MS,
        })
      ).stdout;
    } catch (error) {
      // A non-zero exit still carries the CLI's PI_HOST_FAILED line.
      stdout = String((error as { stdout?: unknown }).stdout ?? "");
      if (!stdout.includes(MARKER_FAILED)) throw error;
    }
    return parseImportOutput(stdout);
  } finally {
    transport.dispose();
  }
}
