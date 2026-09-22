/**
 * Extension-visible provider/model access (extension-model-registry plan, S1).
 *
 * Main owns the provider catalogue and every credential; the agent sidecar
 * receives only the redacted {@link HostModelDescriptor} rows below and turns
 * them into pi-ai `Model<Api>` values. Upstream `ModelRegistry` reads are
 * synchronous, so this module holds a snapshot instead of fetching on read: one
 * instance belongs to one Runner (one session), and it keeps no module-level
 * state — module instances are shared by every Runner in the process (spec
 * 16 §4.3), so module-scoped state would leak between sessions.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveApiStyle } from "@pi-desktop/shared";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  apiBindingForStyle,
} from "../provider-binding.js";

/**
 * One ready catalogue row: exactly what the sidecar needs to build a
 * `Model<Api>` and answer auth questions, and nothing else.
 *
 * `baseUrl` is included because `Model<Api>` requires it and it is not a
 * secret (the renderer already renders it). `apiKey`, provider `headers`,
 * secret references, and the raw provider config are never carried here, so no
 * credential material can reach an extension through this type.
 */
export type HostModelDescriptor = {
  providerId: string;
  providerName: string;
  modelId: string;
  label: string;
  alias?: string;
  /** Provider-wide wire style; the model-level `modelApi` wins when present. */
  apiStyle?: string;
  /** Wire API pinned by the catalog for this model. */
  modelApi?: string;
  baseUrl: string;
  isDefault?: boolean;
  supportsReasoning: boolean;
  /** Image input capability. */
  supportsImages: boolean;
  /** host-core semantics: an API key OR an OAuth credential is stored. */
  hasSecret: boolean;
  hasOauth: boolean;
  authKind: string;
  toolCall: boolean;
  thinkingLevels: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  modalities?: { input: string[]; output: string[] };
};

/** Upstream `AuthStatus` (pi-coding-agent `dist/core/provider-composer.d.ts:43-47`). */
export type ExtensionProviderAuthStatus = {
  configured: boolean;
  source?:
    | "stored"
    | "runtime"
    | "environment"
    | "fallback"
    | "models_json_key"
    | "models_json_command";
  label?: string;
};

/** Upstream `ModelsRefreshResult` (pi-ai `dist/models.d.ts:37-40`). */
export type ExtensionModelRefreshResult = {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
};

/**
 * The `ModelRegistry` members PI supports. The remaining upstream members are
 * present and inert; the Runner enumerates them (spec 16 §5, plan §3).
 *
 * `getAll()` and `getAvailable()` project the same ready set: upstream
 * `getAll` semantics could not be verified against the shipped package, so PI
 * does not invent a wider "known models" set (plan D1/D2, recorded in the ADR).
 */
export type ExtensionModelRegistry = {
  getAll(): Model<Api>[];
  getAvailable(): Model<Api>[];
  find(providerId: string, modelId: string): Model<Api> | undefined;
  getProviderDisplayName(providerId: string): string;
  getProviderAuthStatus(providerId: string): ExtensionProviderAuthStatus;
  hasConfiguredAuth(model: Model<Api>): boolean;
  refresh(options?: unknown): Promise<ExtensionModelRefreshResult>;
};

export type ExtensionModelRegistryOptions = {
  callHost: (method: string, params: unknown) => Promise<unknown>;
  sessionId: string;
  /**
   * Plugin-registered agent models and the session model, appended to every
   * read. Read through a closure because both are created after the registry
   * and can change during the session.
   */
  extraModels: () => Model<Api>[];
  /**
   * The display names of the plugin-registered agent providers. Read lazily for
   * the same reason as `extraModels` — the Runner that owns them is created
   * after this registry — so `getProviderDisplayName` keeps answering with the
   * plugin agent's name instead of the raw `agent-extension:<key>` id.
   */
  extraProviderNames: () => Array<{ providerId: string; name: string }>;
};

/** The request a refresh re-issues; also the key it reports a failure under. */
const CATALOGUE_METHOD = "extensions.providers.list";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Tolerate a malformed or absent catalogue without failing the extension. */
function descriptorRows(value: unknown): HostModelDescriptor[] {
  if (!value || typeof value !== "object") return [];
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.filter(
    (row): row is HostModelDescriptor =>
      Boolean(row) &&
      typeof row === "object" &&
      typeof (row as { providerId?: unknown }).providerId === "string" &&
      typeof (row as { modelId?: unknown }).modelId === "string",
  );
}

/**
 * Project one catalogue row into a pi-ai model. Every required `Model<Api>`
 * field comes from the descriptor, so no type assertion is needed; missing
 * metadata falls back to the same neutral defaults the rest of the runtime uses.
 */
function modelFromDescriptor(descriptor: HostModelDescriptor): Model<Api> {
  const { api } = apiBindingForStyle(
    resolveApiStyle(descriptor.modelApi) ?? descriptor.apiStyle,
  );
  const input: Array<"text" | "image"> = descriptor.supportsImages
    ? ["text", "image"]
    : ["text"];
  const cost = descriptor.cost ?? ZERO_COST;
  return {
    id: descriptor.modelId,
    // A user-assigned model alias is the display name; the catalogue label is
    // the fallback when the binding carries none.
    name: descriptor.alias?.trim() || descriptor.label,
    api,
    provider: descriptor.providerId,
    baseUrl: descriptor.baseUrl,
    reasoning: descriptor.supportsReasoning,
    input,
    cost: {
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
    },
    contextWindow: descriptor.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: descriptor.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/**
 * host-core's `has_secret` means "API key OR OAuth" (D9), so both flags are
 * consulted; `authKind === "none"` needs no credential at all.
 */
function hasConfiguredAuthRow(row: HostModelDescriptor | undefined): boolean {
  return (
    row !== undefined &&
    (row.hasSecret || row.hasOauth || row.authKind === "none")
  );
}

function abortSignalOf(options: unknown): AbortSignal | undefined {
  if (!options || typeof options !== "object") return undefined;
  const signal = (options as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** The snapshot and the models it projects, installed together. */
type CatalogueSnapshot = {
  descriptors: HostModelDescriptor[];
  models: Model<Api>[];
};

/**
 * Prime a Runner-scoped registry from main's catalogue.
 *
 * Reads stay synchronous: the snapshot is primed here and replaced only by
 * `refresh()`. A failed priming (missing grant, host gone) leaves the snapshot
 * empty while the registry keeps answering with `extraModels()`, so an
 * extension that only uses `registerAgent` keeps working.
 */
export async function createExtensionModelRegistry(
  options: ExtensionModelRegistryOptions,
): Promise<ExtensionModelRegistry> {
  let descriptors: HostModelDescriptor[] = [];
  let catalogueModels: Model<Api>[] = [];

  const fetchCatalogue = async (): Promise<CatalogueSnapshot> => {
    const result = await options.callHost(CATALOGUE_METHOD, {
      sessionId: options.sessionId,
    });
    const rows = descriptorRows(result);
    return { descriptors: rows, models: rows.map(modelFromDescriptor) };
  };

  const installCatalogue = (snapshot: CatalogueSnapshot): void => {
    descriptors = snapshot.descriptors;
    catalogueModels = snapshot.models;
  };

  try {
    installCatalogue(await fetchCatalogue());
  } catch (error) {
    // A refused or unavailable catalogue is an answer, not a load failure: the
    // registry degrades to the plugin-registered models. It is reported once so
    // an unexpected failure is still diagnosable.
    console.error(
      "[extensions] provider catalogue unavailable:",
      errorMessage(error),
    );
  }

  // Later rows win, so `extraModels()` overrides a catalogue row with the same
  // `provider/id`.
  const readyModels = (): Model<Api>[] => {
    const byKey = new Map<string, Model<Api>>();
    for (const model of catalogueModels) {
      byKey.set(`${model.provider}/${model.id}`, model);
    }
    for (const model of options.extraModels()) {
      byKey.set(`${model.provider}/${model.id}`, model);
    }
    return [...byKey.values()];
  };

  /**
   * A plugin-registered agent provider needs no host credential: the plugin
   * owns its transport, so it is "configured" as soon as it is registered. The
   * session model is part of `extraModels()` too, matching the pre-catalogue
   * two-source answer.
   */
  const pluginOwnedProviders = (): Set<string> =>
    new Set(options.extraModels().map((model) => model.provider));

  const descriptorForProvider = (
    providerId: string,
  ): HostModelDescriptor | undefined =>
    descriptors.find((row) => row.providerId === providerId);

  /**
   * Plugin-owned providers answer `source: "runtime"` — the upstream union's
   * value for a provider the runtime supplies — and win over a catalogue row. A
   * host row with `authKind === "none"` needs no credential at all, so `source`
   * is omitted there and a caller can tell "no credential needed" from "a key is
   * stored".
   */
  const authStatusForProvider = (
    providerId: string,
  ): ExtensionProviderAuthStatus => {
    if (pluginOwnedProviders().has(providerId)) {
      return { configured: true, source: "runtime" };
    }
    const row = descriptorForProvider(providerId);
    if (!hasConfiguredAuthRow(row)) return { configured: false };
    return row?.authKind === "none"
      ? { configured: true }
      : { configured: true, source: "stored" };
  };

  const refresh = async (
    refreshOptions?: unknown,
  ): Promise<ExtensionModelRefreshResult> => {
    const signal = abortSignalOf(refreshOptions);
    if (signal?.aborted) return { aborted: true, errors: new Map() };
    let snapshot: CatalogueSnapshot;
    try {
      snapshot = await fetchCatalogue();
    } catch (error) {
      // A failed refresh keeps the previous snapshot; it never empties the
      // registry. Never throws: the extension gets the failure as data, except
      // that an abort is reported as the abort, not as the failure it caused.
      if (signal?.aborted) return { aborted: true, errors: new Map() };
      return {
        aborted: false,
        errors: new Map([[CATALOGUE_METHOD, asError(error)]]),
      };
    }
    // An abort during the fetch discards the result: a caller that cancelled
    // must not be handed a snapshot it no longer asked for.
    if (signal?.aborted) return { aborted: true, errors: new Map() };
    installCatalogue(snapshot);
    return { aborted: false, errors: new Map() };
  };

  return {
    getAll: () => readyModels(),
    getAvailable: () => readyModels(),
    find: (providerId: string, modelId: string) =>
      readyModels().find(
        (model) => model.provider === providerId && model.id === modelId,
      ),
    getProviderDisplayName: (providerId: string) =>
      options
        .extraProviderNames()
        .find((entry) => entry.providerId === providerId)?.name ??
      descriptorForProvider(providerId)?.providerName ??
      providerId,
    // Truthful availability without key material: `source: "stored"` states
    // that the credential lives in the host, never what it is.
    getProviderAuthStatus: authStatusForProvider,
    hasConfiguredAuth: (model: Model<Api>) => {
      if (pluginOwnedProviders().has(model?.provider)) return true;
      return hasConfiguredAuthRow(
        descriptors.find(
          (row) => row.providerId === model?.provider && row.modelId === model?.id,
        ),
      );
    },
    refresh,
  };
}
