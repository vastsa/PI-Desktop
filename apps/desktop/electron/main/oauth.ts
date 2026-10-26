/**
 * Vendor-account (OAuth) login for model providers.
 *
 * pi-ai owns all supported login flows and the locked token refresh; persistence
 * and the user-facing half of the conversation are the app's job (see
 * `auth/types.d.ts`: "Login/account-removal orchestration is app-owned"). This module is
 * that half:
 *
 *  - a CredentialStore backed by host-core's encrypted secret store, keyed
 *    `secret:provider:<providerRowId>:oauth` so an API key and a vendor account
 *    can coexist on one provider row;
 *  - a bridge from pi-ai's prompt/notify interaction to renderer events;
 *  - short-lived request auth (`ModelAuth`) for the agent sidecar;
 *  - a scoped request credential, including encrypted routing data, for the
 *    explicitly authorized plugin inference adapter only.
 *
 * Refresh tokens are confined to storage and the owning OAuth callback. Neither
 * ordinary `ModelAuth` nor inference credentials include a refresh token.
 */

import { randomUUID } from "node:crypto";
import { createInstallationIdentity } from "./installation-identity.ts";

import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import type {
  Api,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  Model,
  ModelAuth,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import type {
  PluginProviderInferenceContextV1,
  PluginProviderOAuthCredential,
  PluginProviderOAuthEvent,
  PluginProviderOAuthPrompt,
  PluginProviderOAuthRequest,
} from "@pi-desktop/plugin-sdk";
import { validateProviderRequestData } from "@pi-desktop/plugin-sdk";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  capabilitiesFromModelConfig,
  genericModelConfig,
  installProviderHeadersFetch,
  modelConfigWithBinding,
  runWithProviderHeaders,
  type ModelConfig,
  type VendorModelBinding,
} from "@pi-desktop/agent-runtime";
import {
  isConversationModelId,
  parseVendorModelIds,
  readVendorModelList,
  VendorModelListError,
  vendorModelListRequest,
  wireForLiveModel,
} from "./vendor-live-models.ts";
import type { ThinkingLevel } from "@pi-desktop/shared";
import { pluginOAuthSourceMatches } from "./plugin-provider-source.ts";
import { runProviderTemplateOAuth, type ProviderTemplateOAuthNetwork } from "./provider-template-oauth.ts";
import {
  OAUTH_AUTH_KIND,
  type OAuthLoginEvent,
  type OAuthPromptRequest,
  type OAuthRespondInput,
  type OAuthStartResult,
  type OAuthVendor,
  type ModelBinding,
} from "@pi-desktop/shared";

export { OAUTH_AUTH_KIND };

/** Mirrors `secret_ref_for_provider_oauth` in crates/host-core/src/secrets.rs. */
export function secretRefForProviderOauth(providerId: string): string {
  return `secret:provider:${providerId}:oauth`;
}

const API_STYLE_BY_WIRE_API: Record<string, string> = {
  "anthropic-messages": "anthropic_messages",
  "openai-completions": "chat_completions",
  "openai-responses": "responses",
  "openai-codex-responses": "openai_codex_responses",
  "google-generative-ai": "google_generative_ai",
  "pi-messages": "pi_messages",
};

const PROTOCOL_BY_API_STYLE: Record<string, string> = {
  anthropic_messages: "anthropic",
  chat_completions: "openai_compatible",
  responses: "openai",
  openai_codex_responses: "openai",
  google_generative_ai: "google",
  pi_messages: "custom_http",
};

/**
 * A provider row stores one apiStyle, but a vendor can span wire APIs (GitHub
 * Copilot serves Anthropic, Chat Completions and Responses models), so the
 * style follows the selected model rather than the vendor.
 */
export function apiStyleForWireApi(api: string): string {
  return API_STYLE_BY_WIRE_API[api] ?? "chat_completions";
}

function wireApiForStyle(style: string): Api {
  return Object.entries(API_STYLE_BY_WIRE_API).find(([, value]) => value === style)?.[0] ?? "openai-completions";
}

/** Interpret an explicitly supplied wire map without borrowing another model's record. */
function withMappedThinkingLevels(config: ModelConfig): ModelConfig {
  if (!config.thinkingLevelMap) return config;
  const supportedThinkingLevels = Object.entries(config.thinkingLevelMap).flatMap(([level, value]) =>
    typeof value === "string" ? [level as ThinkingLevel] : [],
  );
  return {
    ...config,
    reasoning: supportedThinkingLevels.some((level) => level !== "off"),
    supportedThinkingLevels,
  };
}

export function protocolForApiStyle(apiStyle: string): string {
  return PROTOCOL_BY_API_STYLE[apiStyle] ?? "openai_compatible";
}

const LIVE_MODELS_TTL_MS = 30_000;
const LIVE_MODELS_NEGATIVE_TTL_MS = 15_000;

/** xAI and the other account lists also publish generators. Those are not conversation models. */
export function isXaiConversationModel(modelId: string): boolean {
  return isConversationModelId(modelId);
}

export type HostCall = <T = unknown>(
  method: string,
  params?: unknown,
) => Promise<T>;

/** The slice of a provider row this module reads; the rest stays in index.ts. */
export type OAuthProviderRow = {
  id: string;
  name?: string;
  vendorKey?: string;
  ownerPluginId?: string;
  pluginTemplateId?: string;
  pluginTemplateVersion?: 1;
  authKind?: string;
  hasOauth?: boolean;
  oauthAccountLabel?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  apiStyle?: string;
  models?: ModelBinding[];
  enabled?: boolean;
  defaultModelId?: string;
};

export type PluginOAuthProvider = {
  pluginId: string;
  runtimeId: string;
  contributionId: string;
  providerId: string;
  templateId?: string;
  pluginName?: string;
  oauth?: import("@pi-desktop/plugin-sdk").PluginProviderTemplateOAuthV1;
  name: string;
  loginLabel?: string;
  isSubscription: boolean;
};

export type PluginOAuthBridge = {
  listOAuthProviders: () => PluginOAuthProvider[];
  providerOAuthSignal?: (provider: PluginOAuthProvider) => AbortSignal;
  invokeProviderOAuth: (
    pluginId: string,
    contributionId: string,
    request: PluginProviderOAuthRequest,
    signal?: AbortSignal,
    expectedRuntimeId?: string,
  ) => Promise<unknown>;
};

/** A model ID offered by a signed-in account and its required wire identity. */
export type OAuthModelOption = {
  modelId: string;
  apiStyle: string;
  baseUrl: string;
};

export type VendorOAuthDeps = {
  /** host-core RPC. Only the generic `secrets.*` and `providers.*` methods. */
  call: HostCall;
  /** Push login progress to the renderer. Never carries token material. */
  emit: (event: OAuthLoginEvent) => void;
  /** Open the vendor's consent page; rejects when no browser could be launched. */
  openExternal: (url: string) => Promise<void>;
  /** Loaded plugin OAuth providers and their isolated callback hooks. */
  getPluginOAuthBridge?: () => PluginOAuthBridge | undefined;
  log?: (
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ) => void;
  /** Stable local installation identity, owned by Host secrets. */
  getInstallationId?: () => Promise<string>;
  /** Share account-owned Models with the catalog without duplicating credentials. */
  onAccountModels?: (providerId: string, models: MutableModels) => void;
  onAccountRemoved?: (providerId: string) => void;
  /** Test seam: build the pi-ai collection without touching the real flows. */
  createModels?: (credentials: CredentialStore) => MutableModels;
  /** Model configuration is supplied by the main-process models.dev catalog. */
  modelConfigFor?: (input: {
    providerId: string;
    vendorKey: string;
    option: OAuthModelOption;
  }) => Promise<ModelConfig | undefined>;
  newId?: () => string;
  /** Test seam. Defaults to the process fetch. */
  fetch?: typeof fetch;
  /** External network seam for isolated declarative OAuth acceptance tests. */
  providerTemplateNetwork?: ProviderTemplateOAuthNetwork;
};

/**
 * A login event minus the identifiers `push()` stamps on. Distributed over the
 * union so each variant keeps its own fields.
 */
type OAuthEventBody = OAuthLoginEvent extends infer Variant
  ? Variant extends unknown
    ? Omit<Variant, "loginId" | "vendorId">
    : never
  : never;

type PendingPrompt = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type AccountModels = {
  providerId: string;
  vendorId: string;
  models: MutableModels;
  pinnedProvider?: Provider;
};

type LoginSession = {
  loginId: string;
  vendorId: string;
  providerId: string;
  account: AccountModels;
  /** Whether this login created the row, and so owns cleaning it up on failure. */
  createdRow: boolean;
  controller: AbortController;
  prompts: Map<string, PendingPrompt>;
  /** Serializes renderer events so `authUrl` cannot overtake an earlier notice. */
  tail: Promise<void>;
  /** Settles once the attempt has torn down; set as soon as it is running. */
  finished?: Promise<void>;
};

type PluginLoginSession = {
  loginId: string;
  vendorId: string;
  providerId: string;
  pluginId: string;
  contributionId: string;
  runtimeId: string;
  prompts: Map<string, PendingPrompt>;
  controller: AbortController;
  tail: Promise<void>;
  cancelled: boolean;
  templateId?: string;
  createdRow?: boolean;
  finished?: Promise<void>;
};

function promptRequest(
  promptId: string,
  prompt: AuthPrompt,
): OAuthPromptRequest {
  return {
    promptId,
    type: prompt.type,
    message: prompt.message,
    placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
    options:
      prompt.type === "select"
        ? prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
            description: option.description,
          }))
        : undefined,
  };
}

function clippedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function normalizePluginCredential(raw: unknown): PluginProviderOAuthCredential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("plugin OAuth credential must be an object");
  }
  const value = raw as Record<string, unknown>;
  const accessToken = value.accessToken;
  if (
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    Buffer.byteLength(accessToken, "utf8") > 16 * 1024
  ) {
    throw new Error("plugin OAuth credential has an invalid accessToken");
  }
  const result: PluginProviderOAuthCredential = { accessToken };
  if (value.refreshToken !== undefined) {
    if (typeof value.refreshToken !== "string" || Buffer.byteLength(value.refreshToken, "utf8") > 16 * 1024) {
      throw new Error("plugin OAuth credential has an invalid refreshToken");
    }
    result.refreshToken = value.refreshToken;
  }
  if (value.expiresAt !== undefined) {
    if (
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0
    ) {
      throw new Error("plugin OAuth credential has an invalid expiresAt");
    }
    result.expiresAt = value.expiresAt;
  }
  if (value.accountLabel !== undefined) {
    if (typeof value.accountLabel !== "string" || value.accountLabel.length > 256) {
      throw new Error("plugin OAuth credential has an invalid accountLabel");
    }
    result.accountLabel = value.accountLabel.trim();
  }
  if (value.headers !== undefined) {
    if (!value.headers || typeof value.headers !== "object" || Array.isArray(value.headers)) {
      throw new Error("plugin OAuth credential headers must be an object");
    }
    const entries = Object.entries(value.headers as Record<string, unknown>);
    if (entries.length > 32) throw new Error("plugin OAuth credential has too many headers");
    const headers: Record<string, string> = {};
    const seenHeaderNames = new Set<string>();
    const blocked = new Set([
      "authorization",
      "proxy-authorization",
      "host",
      "cookie",
      "set-cookie",
      "content-length",
      "transfer-encoding",
      "connection",
      "proxy-connection",
    ]);
    for (const [name, headerValue] of entries) {
      const normalizedName = name.toLowerCase();
      if (
        !/^[A-Za-z0-9-]{1,128}$/.test(name) ||
        blocked.has(normalizedName) ||
        seenHeaderNames.has(normalizedName) ||
        typeof headerValue !== "string" ||
        Buffer.byteLength(headerValue, "utf8") > 4_096 ||
        /[\r\n\0]/.test(headerValue)
      ) {
        throw new Error("plugin OAuth credential has an invalid header");
      }
      seenHeaderNames.add(normalizedName);
      headers[name] = headerValue;
    }
    result.headers = headers;
  }
  if (value.requestData !== undefined) {
    validateProviderRequestData(value.requestData);
    result.requestData = JSON.parse(JSON.stringify(value.requestData));
  }
  return result;
}

export class VendorOAuth {
  private readonly deps: VendorOAuthDeps;
  private readonly logins = new Map<string, LoginSession>();
  private readonly pluginLogins = new Map<string, PluginLoginSession>();
  private readonly pluginRefreshControllers = new Map<string, AbortController>();
  /** One pi-ai collection and credential store per local OAuth account row. */
  private readonly accountModels = new Map<string, AccountModels>();
  /** Successful and failed account model lists, so launch does not refetch per model. */
  private readonly liveModelCache = new Map<string, { at: number; models: OAuthModelOption[] | null }>();
  private readonly liveModelLoads = new Map<string, Promise<OAuthModelOption[] | undefined>>();
  /** Per-account write chain: `modify` must be a serialized read-modify-write. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private catalogPromise?: Promise<MutableModels>;
  private oauthFlowsRegistered = false;
  private readonly getInstallationId: () => Promise<string>;

  constructor(deps: VendorOAuthDeps) {
    this.deps = deps;
    this.getInstallationId = deps.getInstallationId ?? createInstallationIdentity(deps.call);
    installProviderHeadersFetch();
  }

  /** Every vendor pi-ai can sign in to, with every local account row. */
  async listVendors(): Promise<OAuthVendor[]> {
    const models = await this.ensureCatalogModels();
    const rows = await this.rows();
    const vendors = models
      .getProviders()
      .filter((provider) => provider.auth.oauth)
      .map((provider) => {
        const oauth = provider.auth.oauth!;
        const accounts = rows
          .filter(
            (candidate) =>
              candidate.authKind === OAUTH_AUTH_KIND &&
              !candidate.ownerPluginId &&
              candidate.vendorKey === provider.id,
          )
          .map((row) => ({
            providerId: row.id,
            accountLabel: row.oauthAccountLabel || undefined,
            connected: row.hasOauth === true,
          }));
        return {
          vendorId: provider.id,
          name: oauth.name || provider.name,
          loginLabel: oauth.loginLabel,
          isSubscription: oauth.isSubscription === true,
          accounts,
        };
      });
    const pluginBridge = this.deps.getPluginOAuthBridge?.();
    if (!pluginBridge) return vendors;
    for (const provider of pluginBridge.listOAuthProviders()) {
      const matchingRows = rows.filter(candidate => candidate.authKind === OAUTH_AUTH_KIND
        && pluginOAuthSourceMatches(candidate, provider));
      if (!provider.templateId && matchingRows.length === 0) continue;
      const accounts = await Promise.all(matchingRows.map(async row => ({
        providerId: row.id,
        accountLabel: row.oauthAccountLabel || (row.hasOauth ? (await this.readPluginCredential(row.id))?.accountLabel : undefined),
        connected: row.hasOauth === true,
      })));
      vendors.push({
        vendorId: provider.providerId,
        name: provider.templateId ? `${provider.name} · ${provider.pluginName ?? provider.pluginId}` : provider.name,
        loginLabel: provider.loginLabel,
        isSubscription: provider.isSubscription,
        accounts,
      });
    }
    return vendors;
  }

  /**
   * Begin a login. Every attempt gets a fresh provider row and credential
   * store, so signing into the same vendor twice creates two independent
   * accounts instead of silently replacing the first one.
   */
  async start(vendorId: string): Promise<OAuthStartResult> {
    const sources = this.deps.getPluginOAuthBridge?.()?.listOAuthProviders() ?? [];
    const pluginProvider = sources.find(provider => provider.providerId === vendorId);
    if (pluginProvider?.templateId) return this.startPluginLogin(pluginProvider);
    const pluginRow = (await this.rows()).find(candidate => candidate.id === vendorId && candidate.ownerPluginId && candidate.authKind === OAUTH_AUTH_KIND);
    if (pluginRow) {
      const source = sources.find(candidate => pluginOAuthSourceMatches(pluginRow, candidate));
      if (!source) throw new Error("plugin OAuth template is unavailable");
      return this.startPluginLogin(source, pluginRow.id);
    }
    const models = await this.ensureCatalogModels();
    const provider = models.getProvider(vendorId);
    if (!provider?.auth.oauth) {
      throw new Error(`unknown vendor account: ${vendorId}`);
    }
    // A second attempt replaces the one in flight rather than racing it, and
    // waits for it to let go: both hold the same local callback port, so
    // starting before the old one unwinds is how a login fails on arrival.
    const superseded = [...this.logins.values()].filter(
      (running) => running.vendorId === vendorId,
    );
    for (const running of superseded) this.cancel(running.loginId);
    for (const running of superseded) {
      await running.finished?.catch(() => undefined);
    }

    const { provider: row } = await this.deps.call<{
      provider: OAuthProviderRow;
    }>("providers.create", {
      name: provider.auth.oauth?.name || provider.name,
      vendorKey: vendorId,
      type: "native",
      authKind: OAUTH_AUTH_KIND,
      baseUrl: provider.baseUrl,
    });
    const account = this.createAccount(vendorId, row.id);
    const session: LoginSession = {
      loginId: this.nextId(),
      vendorId,
      providerId: row.id,
      account,
      createdRow: true,
      controller: new AbortController(),
      prompts: new Map(),
      tail: Promise.resolve(),
    };
    this.logins.set(session.loginId, session);
    session.finished = this.run(session, provider);
    return { loginId: session.loginId };
  }

  private async startPluginLogin(provider: PluginOAuthProvider, accountId?: string): Promise<OAuthStartResult> {
    let createdRow = false;
    if (provider.templateId && !accountId) {
      const result = await this.deps.call<{ provider: OAuthProviderRow }>("providers.createFromTemplate", {
        pluginId: provider.pluginId, templateId: provider.templateId,
      });
      accountId = result.provider.id;
      createdRow = true;
    }
    accountId ??= provider.providerId;
    const superseded = [...this.pluginLogins.values()].filter(running => running.providerId === accountId);
    for (const running of superseded) this.cancelPluginLogin(running);
    for (const running of superseded) await running.finished;
    const session: PluginLoginSession = {
      loginId: this.nextId(),
      vendorId: createdRow ? provider.providerId : accountId,
      providerId: accountId,
      createdRow,
      templateId: provider.templateId,
      pluginId: provider.pluginId,
      contributionId: provider.contributionId,
      runtimeId: provider.runtimeId,
      prompts: new Map(),
      controller: new AbortController(),
      tail: Promise.resolve(),
      cancelled: false,
    };
    this.pluginLogins.set(session.loginId, session);
    session.finished = this.runPluginLogin(session);
    return { loginId: session.loginId };
  }

  /** Answer a prompt. An absent value cancels the prompt and the login. */
  respond(input: OAuthRespondInput): boolean {
    const session = this.logins.get(input.loginId);
    const pluginSession = this.pluginLogins.get(input.loginId);
    const pending = session?.prompts.get(input.promptId) ?? pluginSession?.prompts.get(input.promptId);
    if ((!session && !pluginSession) || !pending) return false;
    if (input.value === undefined) {
      pending.reject(new Error("login cancelled"));
      if (session) session.controller.abort();
      if (pluginSession) this.cancelPluginLogin(pluginSession);
    } else {
      pending.resolve(input.value);
    }
    return true;
  }

  /** Abort a login: stops the local callback server or device-code polling. */
  cancel(loginId: string): boolean {
    const session = this.logins.get(loginId);
    if (session) {
      session.controller.abort();
      return true;
    }
    const pluginSession = this.pluginLogins.get(loginId);
    if (!pluginSession) return false;
    this.cancelPluginLogin(pluginSession);
    return true;
  }

  /** Plugin callbacks can ask the same Host-rendered question as native OAuth flows. */
  promptPluginOAuth(
    pluginId: string,
    loginId: string,
    input: PluginProviderOAuthPrompt,
  ): Promise<string> {
    const session = this.pluginLogins.get(loginId);
    if (!session || session.pluginId !== pluginId || session.cancelled) {
      return Promise.reject(new Error("provider OAuth login is no longer active"));
    }
    if (
      !input ||
      typeof input !== "object" ||
      !["text", "secret", "select", "manual_code"].includes(input.type) ||
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 2_000
    ) {
      return Promise.reject(new Error("provider OAuth prompt is invalid"));
    }
    if (input.type === "select" && (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 32)) {
      return Promise.reject(new Error("provider OAuth select prompt requires 1 to 32 options"));
    }
    const options = input.type === "select"
      ? (input.options ?? []).flatMap((option) =>
          option && typeof option.id === "string" && typeof option.label === "string"
            ? [{
                id: option.id.slice(0, 128),
                label: option.label.slice(0, 256),
                ...(typeof option.description === "string"
                  ? { description: option.description.slice(0, 512) }
                  : {}),
              }]
            : [],
        )
      : undefined;
    if (input.type === "select" && options?.length === 0) {
      return Promise.reject(new Error("provider OAuth select prompt options are invalid"));
    }
    const promptId = this.nextId();
    return new Promise((resolve, reject) => {
      const settle = () => session.prompts.delete(promptId);
      session.prompts.set(promptId, {
        resolve: (value) => { settle(); resolve(value); },
        reject: (error) => { settle(); reject(error); },
      });
      const request: OAuthPromptRequest = {
        promptId,
        type: input.type,
        message: input.message.trim(),
        ...(typeof input.placeholder === "string" && input.placeholder.length <= 512
          ? { placeholder: input.placeholder }
          : {}),
        ...(options ? { options } : {}),
      };
      this.pushPluginEvent(session, { kind: "prompt", request });
    });
  }

  /** Relay only bounded, non-secret progress to the renderer. */
  async notifyPluginOAuth(
    pluginId: string,
    loginId: string,
    event: PluginProviderOAuthEvent,
  ): Promise<void> {
    const session = this.pluginLogins.get(loginId);
    if (!session || session.pluginId !== pluginId || session.cancelled) {
      throw new Error("provider OAuth login is no longer active");
    }
    if (event.kind === "authUrl") {
      if (!isHttpUrl(event.url)) throw new Error("provider OAuth URL must use HTTP or HTTPS");
      const url = event.url.slice(0, 4_096);
      session.tail = session.tail.then(async () => {
        const opened = await this.deps.openExternal(url).then(() => true, () => false);
        this.deps.emit({
          loginId,
          vendorId: session.vendorId,
          kind: "authUrl",
          url,
          instructions: clippedText(event.instructions, 2_000),
          opened,
        });
      });
      await session.tail;
      return;
    }
    if (event.kind === "deviceCode") {
      if (!isHttpUrl(event.verificationUri)) throw new Error("verificationUri must use HTTP or HTTPS");
      this.pushPluginEvent(session, {
        kind: "deviceCode",
        userCode: clippedText(event.userCode, 256),
        verificationUri: event.verificationUri.slice(0, 4_096),
        ...(Number.isFinite(event.intervalSeconds) ? { intervalSeconds: event.intervalSeconds } : {}),
        ...(Number.isFinite(event.expiresInSeconds) ? { expiresInSeconds: event.expiresInSeconds } : {}),
      });
      await session.tail;
      return;
    }
    if (event.kind === "info") {
      this.pushPluginEvent(session, {
        kind: "info",
        message: clippedText(event.message, 2_000),
        ...(Array.isArray(event.links)
          ? {
              links: event.links.slice(0, 4).flatMap((link) =>
                isHttpUrl(link?.url)
                  ? [{ url: link.url.slice(0, 4_096), ...(typeof link.label === "string" ? { label: link.label.slice(0, 128) } : {}) }]
                  : [],
              ),
            }
          : {}),
      });
      await session.tail;
      return;
    }
    this.pushPluginEvent(session, { kind: "progress", message: clippedText(event.message, 2_000) });
    await session.tail;
  }

  invalidatePluginAccount(providerId: string): void {
    this.pluginRefreshControllers.get(providerId)?.abort(new Error("provider changed"));
    for (const session of this.pluginLogins.values()) {
      if (session.providerId === providerId) this.cancelPluginLogin(session);
    }
    this.invalidateAccountModels(providerId);
  }

  /**
   * Delete one account's provider row and its provider-scoped OAuth secret.
   * Host-core owns the atomic cleanup of the row and both secret references.
   */
  async deleteAccount(providerId: string): Promise<void> {
    const row = (await this.rows()).find((candidate) => candidate.id === providerId);
    if (!row || row.authKind !== OAUTH_AUTH_KIND) {
      throw new Error(`unknown vendor account provider: ${providerId}`);
    }
    if (row.ownerPluginId) {
      this.pluginRefreshControllers.get(providerId)?.abort(new Error("provider sign-out requested"));
      const running = [...this.pluginLogins.values()].find(
        (session) => session.providerId === providerId,
      );
      if (running) this.cancelPluginLogin(running);
      if (running) await running.finished;
      await this.serialize(providerId, () => row.pluginTemplateId
        ? this.deps.call("providers.delete", { id: providerId })
        : this.deps.call("secrets.delete", { secretRef: secretRefForProviderOauth(providerId) }));
      this.clearAccountModels(providerId);
      return;
    }
    const running = [...this.logins.values()].find(
      (session) => session.providerId === providerId,
    );
    if (running) {
      this.cancel(running.loginId);
      await running.finished?.catch(() => undefined);
    }
    await this.deps.call("providers.delete", { id: providerId });
    this.accountModels.delete(providerId);
    this.deps.onAccountRemoved?.(providerId);
    this.liveModelCache.delete(providerId);
    this.liveModelLoads.delete(providerId);
  }

  /**
   * Resolve request auth for one model request. pi-ai refreshes the token under
   * the store lock when it has expired; the caller only ever sees the resulting
   * short-lived access token, headers and per-credential baseUrl.
   */
  async resolveAuth(providerId: string): Promise<ModelAuth> {
    const row = (await this.rows()).find((candidate) => candidate.id === providerId);
    if (row?.ownerPluginId && row.authKind === OAUTH_AUTH_KIND) {
      const credential = await this.resolvePluginCredential(row);
      return {
        apiKey: credential.accessToken,
        ...(credential.headers ? { headers: credential.headers } : {}),
      };
    }
    return this.withRowHeaders(providerId, async () => {
      const account = await this.accountForProvider(providerId);
      if (!account) throw new Error(`vendor account not signed in: ${providerId}`);
      const resolved = await account.models.getAuth(account.vendorId);
      if (!resolved) throw new Error(`vendor account not signed in: ${providerId}`);
      return resolved.auth;
    });
  }

  /** Main-only: the broker must authorize this provider's custom inference adapter before calling. */
  async resolvePluginInferenceCredential(
    providerId: string,
  ): Promise<NonNullable<PluginProviderInferenceContextV1["credential"]>> {
    const row = (await this.rows()).find((candidate) => candidate.id === providerId);
    if (!row) throw new Error("plugin inference OAuth account is unavailable");
    const provider = this.requirePluginInferenceOwner(row);
    const credential = await this.resolvePluginCredential(row, provider);
    const latest = (await this.rows()).find((candidate) => candidate.id === providerId);
    this.requirePluginInferenceOwner(latest, provider);
    return {
      apiKey: credential.accessToken,
      ...(credential.headers ? { headers: credential.headers } : {}),
      ...(credential.requestData !== undefined ? { requestData: credential.requestData } : {}),
    };
  }

  private requirePluginInferenceOwner(
    row: OAuthProviderRow | undefined,
    expected?: PluginOAuthProvider,
  ): PluginOAuthProvider {
    if (!row?.ownerPluginId || row.authKind !== OAUTH_AUTH_KIND || row.enabled === false || !row.hasOauth) {
      throw new Error("plugin inference OAuth account is unavailable");
    }
    const provider = this.deps.getPluginOAuthBridge?.()?.listOAuthProviders()
      .find(candidate => pluginOAuthSourceMatches(row, candidate));
    if (!provider || (expected && (provider.pluginId !== expected.pluginId
      || provider.runtimeId !== expected.runtimeId || provider.contributionId !== expected.contributionId))) {
      throw new Error("plugin inference OAuth owner changed or is unavailable");
    }
    return provider;
  }

  /**
   * Models the signed-in account may actually use.
   *
   * The account's own model list is the authority. pi-ai (`getAvailable`,
   * including a vendor `filterModels`) is used only when that request cannot
   * be read. Radius keeps its gateway refresh and does not get a second probe.
   */
  async listModels(providerId: string): Promise<OAuthModelOption[]> {
    const row = (await this.rows()).find((candidate) => candidate.id === providerId);
    if (row?.ownerPluginId && row.authKind === OAUTH_AUTH_KIND) {
      if (!row.baseUrl) return [];
      const baseUrl = row.baseUrl;
      return (row.models ?? []).map((model) => ({
        modelId: model.id,
        apiStyle: row.apiStyle ?? "chat_completions",
        baseUrl,
      }));
    }
    return this.withRowHeaders(providerId, async () => {
      const account = await this.accountForProvider(providerId);
      if (!account) throw new Error(`unknown vendor account provider: ${providerId}`);
      // Dynamic catalogs (radius) are empty until refreshed.
      await account.models.refresh({ providers: [account.vendorId] });
      const available = await account.models.getAvailable(account.vendorId);
      return available.map((model) => this.optionFor(model));
    });
  }

  private optionFor(model: Model<Api>): OAuthModelOption {
    return {
      modelId: model.id,
      apiStyle: apiStyleForWireApi(model.api),
      baseUrl: model.baseUrl,
    };
  }

  /**
   * Everything a provider binding needs for one model of a signed-in account.
   *
   * A vendor row cannot take this from the builtin catalog: one account spans
   * wire APIs (GitHub Copilot serves Anthropic, Chat Completions and Responses
   * models, so the selected model — not the row — decides the style), and a
   * gateway's catalog (radius) is not in the builtin one at all. The
   * authenticated collection knows both.
   */
  async bindingFor(
    providerId: string,
    modelId: string,
  ): Promise<VendorModelBinding | undefined> {
    const row = (await this.rows()).find((candidate) => candidate.id === providerId);
    if (row?.ownerPluginId && row.authKind === OAUTH_AUTH_KIND) {
      const declared = row.models?.find((model) => model.id === modelId);
      if (!declared || !row.baseUrl) return undefined;
      const option: OAuthModelOption = {
        modelId: declared.id,
        apiStyle: row.apiStyle ?? "chat_completions",
        baseUrl: row.baseUrl,
      };
      const published = await this.deps.modelConfigFor?.({
        providerId: row.id,
        vendorKey: row.vendorKey ?? "custom",
        option,
      }).catch(() => undefined);
      const baseline = withMappedThinkingLevels(
        published ?? genericModelConfig(option.modelId, option.baseUrl),
      );
      const model = modelConfigWithBinding(baseline, {
        ...declared,
        contextWindow: declared.contextWindow > 0 ? declared.contextWindow : baseline.contextWindow,
        maxTokens: declared.maxTokens > 0 ? declared.maxTokens : baseline.maxTokens,
      });
      const modelConfig = declared.thinkingLevels.length > 0
        ? withMappedThinkingLevels(model)
        : { ...model, reasoning: false, supportedThinkingLevels: [] };
      return {
        apiStyle: option.apiStyle,
        baseUrl: option.baseUrl,
        modelConfig,
        ...capabilitiesFromModelConfig(modelConfig),
      };
    }
    return this.withRowHeaders(providerId, () =>
      this.bindingForUnscoped(providerId, modelId),
    );
  }

  private async bindingForUnscoped(
    providerId: string,
    modelId: string,
  ): Promise<VendorModelBinding | undefined> {
    const account = await this.accountForProvider(providerId);
    if (!account) return undefined;
    await account.models.refresh({ providers: [account.vendorId] });
    const model = account.models.getModel(account.vendorId, modelId);
    if (!model) return undefined;
    return this.bindingFromOption(account, this.optionFor(model));
  }

  /**
   * Chat models the signed-in account can call right now.
   * `undefined` means the live list could not be read; callers keep the
   * pinned catalog.
   */
  private async liveAccountModels(
    account: AccountModels,
  ): Promise<OAuthModelOption[] | undefined> {
    if (account.vendorId === "radius") return undefined;
    const cached = this.liveModelCache.get(account.providerId);
    if (cached) {
      const ttl = cached.models ? LIVE_MODELS_TTL_MS : LIVE_MODELS_NEGATIVE_TTL_MS;
      if (Date.now() - cached.at < ttl) return cached.models ?? undefined;
    }
    const pending = this.liveModelLoads.get(account.providerId);
    if (pending) return pending;
    const load = this.loadLiveAccountModels(account).finally(() => {
      if (this.liveModelLoads.get(account.providerId) === load) this.liveModelLoads.delete(account.providerId);
    });
    this.liveModelLoads.set(account.providerId, load);
    return load;
  }

  private rememberLiveModels(
    account: AccountModels,
    models: OAuthModelOption[] | null,
  ): OAuthModelOption[] | undefined {
    if (this.accountModels.get(account.providerId) === account) {
      this.liveModelCache.set(account.providerId, { at: Date.now(), models });
    }
    return models ?? undefined;
  }

  private async loadLiveAccountModels(
    account: AccountModels,
  ): Promise<OAuthModelOption[] | undefined> {
    let apiKey: string | undefined;
    let baseUrl: string | undefined;
    try {
      const resolved = await account.models.getAuth(account.vendorId);
      apiKey = resolved?.auth.apiKey;
      baseUrl = resolved?.auth.baseUrl;
    } catch (error) {
      this.log("warn", "vendor account auth unavailable for model list", {
        vendorId: account.vendorId,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    const request = vendorModelListRequest({
      vendorId: account.vendorId,
      apiKey,
      baseUrl,
    });
    if (!request) return undefined;
    try {
      const body = await readVendorModelList(request, this.deps.fetch ?? globalThis.fetch);
      const ids = parseVendorModelIds(account.vendorId, body, request.allowPolicyFallback);
      if (!ids || ids.length === 0) return this.rememberLiveModels(account, null);
      const pinned = account.pinnedProvider?.getModels() ?? await account.models.getAvailable(account.vendorId);
      const known = new Map(pinned.map((model) => [model.id, model]));
      const wires = pinned.map((model) => ({
        id: model.id,
        api: model.api,
        baseUrl: model.baseUrl,
      }));
      const models = ids.flatMap((modelId) => {
        const pinnedModel = known.get(modelId);
        if (pinnedModel) return [this.optionFor(pinnedModel)];
        const wire = wireForLiveModel(account.vendorId, modelId, wires, request.accountBaseUrl);
        if (!wire?.api || !wire.baseUrl) return [];
        return [{
          modelId,
          apiStyle: apiStyleForWireApi(wire.api),
          baseUrl: wire.baseUrl,
        }];
      });
      if (models.length === 0) return this.rememberLiveModels(account, null);
      return this.rememberLiveModels(account, models);
    } catch (error) {
      this.log("warn", "vendor account model list failed", {
        vendorId: account.vendorId,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof VendorModelListError
          ? { status: error.status, responseExcerpt: error.responseExcerpt }
          : {}),
      });
      return this.rememberLiveModels(account, null);
    }
  }

  private async bindingFromOption(
    account: AccountModels,
    option: OAuthModelOption,
  ): Promise<VendorModelBinding> {
    const published = await this.deps.modelConfigFor?.({
      providerId: account.providerId,
      vendorKey: account.vendorId,
      option,
    }).catch(() => undefined);
    const modelConfig = withMappedThinkingLevels(
      published ?? genericModelConfig(option.modelId, option.baseUrl),
    );
    const capabilities = capabilitiesFromModelConfig(modelConfig);
    return {
      apiStyle: option.apiStyle,
      baseUrl: option.baseUrl,
      modelConfig,
      ...capabilities,
    };
  }

  private async run(session: LoginSession, provider: Provider): Promise<void> {
    try {
      const installationId = await this.getInstallationId();
      session.controller.signal.throwIfAborted();
      await this.withRowHeaders(session.providerId, () =>
        session.account.models.login(
          session.vendorId,
          "oauth",
          this.interactionFor(session),
          { getDeviceId: () => installationId },
        ),
      );
      const accountLabel = provider.auth.oauth?.name || provider.name;
      await this.completeRow(session, provider, accountLabel);
      this.push(session, {
        kind: "done",
        providerId: session.providerId,
        accountLabel,
      });
    } catch (error) {
      await this.discardRow(session);
      if (session.controller.signal.aborted) {
        this.push(session, { kind: "cancelled" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.log("warn", "vendor account login failed", {
          vendorId: session.vendorId,
          message,
        });
        this.push(session, { kind: "error", message });
      }
    } finally {
      for (const pending of session.prompts.values()) {
        pending.reject(new Error("login finished"));
      }
      await session.tail;
      this.logins.delete(session.loginId);
    }
  }

  private async invokePluginOAuth(source: PluginOAuthProvider, request: PluginProviderOAuthRequest, signal: AbortSignal): Promise<unknown> {
    const bridge = this.deps.getPluginOAuthBridge?.();
    if (!bridge) throw new Error("provider OAuth is unavailable");
    const ownerSignal = bridge.providerOAuthSignal?.(source);
    const combined = ownerSignal ? AbortSignal.any([signal, ownerSignal]) : signal;
    combined.throwIfAborted();
    if (source.templateId && source.oauth?.flow && source.oauth.flow !== "custom") {
      return runProviderTemplateOAuth(source.oauth, request, {
        signal: combined,
        network: this.deps.providerTemplateNetwork,
        notify: event => request.loginId ? this.notifyPluginOAuth(source.pluginId, request.loginId, event) : undefined,
        openExternal: url => request.loginId ? this.notifyPluginOAuth(source.pluginId, request.loginId, { kind: "authUrl", url }) : undefined,
      });
    }
    return bridge.invokeProviderOAuth(source.pluginId, source.contributionId, request, combined, source.runtimeId);
  }


  private async runPluginLogin(session: PluginLoginSession): Promise<void> {
    try {
      const bridge = this.deps.getPluginOAuthBridge?.();
      if (!bridge) throw new Error("provider OAuth is unavailable");
      const source = bridge.listOAuthProviders().find(candidate => candidate.pluginId === session.pluginId
        && candidate.contributionId === session.contributionId && candidate.runtimeId === session.runtimeId);
      if (!source) throw new Error("provider OAuth source is unavailable");
      const raw = await this.invokePluginOAuth(source,
        {
          operation: "login",
          providerId: session.contributionId,
          ...(session.templateId ? { accountId: session.providerId } : {}),
          loginId: session.loginId,
        },
        session.controller.signal,
      );
      if (session.cancelled) throw new Error("login cancelled");
      const credential = normalizePluginCredential(raw);
      await this.serialize(session.providerId, async () => {
        const row = (await this.rows()).find((candidate) => candidate.id === session.providerId);
        const currentProvider = bridge.listOAuthProviders().find(
          candidate => row !== undefined && pluginOAuthSourceMatches(row, candidate),
        );
        if (
          session.cancelled ||
          currentProvider?.runtimeId !== session.runtimeId ||
          row?.ownerPluginId !== session.pluginId ||
          row.authKind !== OAUTH_AUTH_KIND ||
          (row.enabled === false && !session.createdRow && !session.templateId)
        ) {
          throw new Error("plugin provider changed during OAuth sign-in");
        }
        await this.writePluginCredential(session.providerId, credential);
        if (session.templateId) await this.deps.call("providers.completeTemplateOAuth", { id: session.providerId });
        const savedRow = (await this.rows()).find((candidate) => candidate.id === session.providerId);
        const savedProvider = this.deps.getPluginOAuthBridge?.()
          ?.listOAuthProviders()
          .find(candidate => savedRow !== undefined && pluginOAuthSourceMatches(savedRow, candidate));
        if (
          session.cancelled || session.controller.signal.aborted ||
          savedRow?.ownerPluginId !== session.pluginId ||
          savedRow.authKind !== OAUTH_AUTH_KIND ||
          (savedRow.enabled === false && !session.templateId) ||
          savedProvider?.runtimeId !== session.runtimeId
        ) {
          await this.deps.call("secrets.delete", {
            secretRef: secretRefForProviderOauth(session.providerId),
          });
          throw new Error("plugin provider changed during OAuth sign-in");
        }
      });
      this.invalidateAccountModels(session.providerId);
      this.pushPluginEvent(session, {
        kind: "done",
        providerId: session.providerId,
        accountLabel: credential.accountLabel,
      });
    } catch {
      if (session.createdRow) {
        try { await this.deps.call("providers.delete", { id: session.providerId }); }
        catch { this.log("error", "pending plugin account cleanup failed", { providerId: session.providerId }); }
      }
      if (session.cancelled) {
        this.pushPluginEvent(session, { kind: "cancelled" });
      } else {
        // Callback errors are plugin-controlled and may contain token material.
        // Keep the user-facing diagnostic useful without reflecting the error.
        this.pushPluginEvent(session, {
          kind: "error",
          code: "PLUGIN_OAUTH_FAILED",
          message: "",
        });
        this.log("warn", "plugin provider OAuth sign-in failed", {
          pluginId: session.pluginId,
          providerId: session.providerId,
        });
      }
    } finally {
      for (const pending of session.prompts.values()) {
        pending.reject(new Error("login finished"));
      }
      await session.tail;
      this.pluginLogins.delete(session.loginId);
    }
  }

  private cancelPluginLogin(session: PluginLoginSession): void {
    if (session.cancelled) return;
    session.cancelled = true;
    session.controller.abort(new Error("login cancelled"));
    for (const pending of session.prompts.values()) {
      pending.reject(new Error("login cancelled"));
    }
  }

  private pushPluginEvent(
    session: PluginLoginSession,
    event: OAuthEventBody,
  ): void {
    session.tail = session.tail.then(() => {
      if (session.cancelled && event.kind !== "cancelled") return;
      this.deps.emit({
        ...event,
        loginId: session.loginId,
        vendorId: session.vendorId,
      } as OAuthLoginEvent);
    });
  }

  private async resolvePluginCredential(
    row: OAuthProviderRow,
    expectedProvider?: PluginOAuthProvider,
  ): Promise<PluginProviderOAuthCredential> {
    if (!row.ownerPluginId || !row.hasOauth) {
      throw new Error(`plugin provider account not signed in: ${row.id}`);
    }
    expectedProvider ??= this.requirePluginInferenceOwner(row);
    return this.serialize(row.id, async () => {
      if (expectedProvider) {
        this.requirePluginInferenceOwner((await this.rows()).find(candidate => candidate.id === row.id), expectedProvider);
      }
      let current = await this.readPluginCredential(row.id);
      if (!current) throw new Error(`plugin provider account not signed in: ${row.id}`);
      if (expectedProvider) {
        this.requirePluginInferenceOwner((await this.rows()).find(candidate => candidate.id === row.id), expectedProvider);
      }
      if (current.expiresAt !== undefined && current.expiresAt <= Date.now() + 30_000) {
        if (!current.refreshToken) throw new Error(`plugin provider credential expired: ${row.id}`);
        const provider = this.deps.getPluginOAuthBridge?.()
          ?.listOAuthProviders()
          .find(candidate => pluginOAuthSourceMatches(row, candidate));
        const bridge = this.deps.getPluginOAuthBridge?.();
        if (!provider || !bridge) throw new Error(`plugin provider OAuth is unavailable: ${row.id}`);
        const refreshController = new AbortController();
        this.pluginRefreshControllers.set(row.id, refreshController);
        let rawRefreshed: unknown;
        try {
          rawRefreshed = await this.invokePluginOAuth(provider,
            {
              operation: "refresh",
              providerId: provider.contributionId,
              ...(row.pluginTemplateId ? { accountId: row.id } : {}),
              credential: current,
            },
            refreshController.signal,
          );
        } finally {
          if (this.pluginRefreshControllers.get(row.id) === refreshController) {
            this.pluginRefreshControllers.delete(row.id);
          }
        }
        const refreshed = normalizePluginCredential(rawRefreshed);
        current = {
          ...refreshed,
          ...(refreshed.refreshToken ? {} : { refreshToken: current.refreshToken }),
          ...(refreshed.accountLabel ? {} : current.accountLabel ? { accountLabel: current.accountLabel } : {}),
          ...(refreshed.headers ? {} : current.headers ? { headers: current.headers } : {}),
          ...(refreshed.requestData !== undefined ? {} : current.requestData !== undefined ? { requestData: current.requestData } : {}),
        };
        const latest = (await this.rows()).find((candidate) => candidate.id === row.id);
        const latestProvider = this.deps.getPluginOAuthBridge?.()?.listOAuthProviders()
          .find(candidate => latest !== undefined && pluginOAuthSourceMatches(latest, candidate));
        if (
          !latest ||
          latest.ownerPluginId !== row.ownerPluginId ||
          latest.authKind !== OAUTH_AUTH_KIND ||
          latest.enabled === false ||
          latestProvider?.runtimeId !== provider.runtimeId
        ) {
          throw new Error(`plugin provider changed during OAuth refresh: ${row.id}`);
        }
        await this.writePluginCredential(row.id, current);
        const savedRow = (await this.rows()).find((candidate) => candidate.id === row.id);
        const savedProvider = this.deps.getPluginOAuthBridge?.()
          ?.listOAuthProviders()
          .find(candidate => savedRow !== undefined && pluginOAuthSourceMatches(savedRow, candidate));
        if (
          !savedRow ||
          savedRow.ownerPluginId !== row.ownerPluginId ||
          savedRow.authKind !== OAUTH_AUTH_KIND ||
          savedRow.enabled === false ||
          savedProvider?.pluginId !== row.ownerPluginId ||
          savedProvider?.runtimeId !== provider.runtimeId
        ) {
          await this.deps.call("secrets.delete", {
            secretRef: secretRefForProviderOauth(row.id),
          });
          throw new Error(`plugin provider changed during OAuth refresh: ${row.id}`);
        }
      }
      return current;
    });
  }

  private async readPluginCredential(
    providerId: string,
  ): Promise<PluginProviderOAuthCredential | undefined> {
    const { value } = await this.deps.call<{ value?: string | null }>(
      "secrets.getForRuntime",
      { secretRef: secretRefForProviderOauth(providerId) },
    );
    if (!value) return undefined;
    try {
      return normalizePluginCredential(JSON.parse(value));
    } catch {
      this.log("warn", "stored plugin provider credential is not readable", { providerId });
      return undefined;
    }
  }

  private async writePluginCredential(
    providerId: string,
    credential: PluginProviderOAuthCredential,
  ): Promise<void> {
    await this.deps.call("secrets.set", {
      secretRef: secretRefForProviderOauth(providerId),
      value: JSON.stringify(credential),
    });
  }

  private clearAccountModels(providerId: string): void {
    this.invalidateAccountModels(providerId);
    this.deps.onAccountRemoved?.(providerId);
  }

  private invalidateAccountModels(providerId: string): void {
    this.accountModels.delete(providerId);
    this.liveModelCache.delete(providerId);
    this.liveModelLoads.delete(providerId);
  }

  /** Point the row at a usable model now that the catalog can be read. */
  private async completeRow(
    session: LoginSession,
    provider: Provider,
    accountLabel: string,
  ): Promise<void> {
    let options: OAuthModelOption[] = [];
    try {
      options = await this.listModels(session.providerId);
    } catch (error) {
      // A catalog that will not load is not worth failing a good login over;
      // the row stays selectable and the model picker retries later.
      this.log("warn", "vendor model catalog unavailable after login", {
        vendorId: session.vendorId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const chosen = options[0];
    const apiStyle = chosen?.apiStyle;
    const modelBindings: ModelBinding[] = [];
    for (const option of options) {
      const binding = await this.bindingFor(session.providerId, option.modelId).catch(
        () => undefined,
      );
      const levels = binding?.supportedThinkingLevels ?? ["off"];
      modelBindings.push({
        id: option.modelId,
        contextWindow: binding?.modelConfig.contextWindow ?? 128_000,
        maxTokens: binding?.modelConfig.maxTokens ?? 8_192,
        thinkingLevels: [...levels],
        defaultThinkingLevel: levels.includes("medium") ? "medium" : levels[0] ?? null,
      });
    }
    await this.deps.call("providers.update", {
      id: session.providerId,
      name: provider.auth.oauth?.name || provider.name,
      authKind: OAUTH_AUTH_KIND,
      oauthAccountLabel: accountLabel,
      baseUrl: chosen?.baseUrl ?? provider.baseUrl,
      ...(modelBindings.length > 0 ? { models: modelBindings } : {}),
      ...(apiStyle
        ? {
            apiStyle,
            protocol: protocolForApiStyle(apiStyle),
            defaultModelId: chosen?.modelId,
          }
        : {}),
    });
  }

  private async discardRow(session: LoginSession): Promise<void> {
    if (!session.createdRow) return;
    try {
      await this.deps.call("providers.delete", { id: session.providerId });
      this.accountModels.delete(session.providerId);
      this.liveModelCache.delete(session.providerId);
      this.liveModelLoads.delete(session.providerId);
      this.deps.onAccountRemoved?.(session.providerId);
    } catch (error) {
      this.log("warn", "could not remove the half-created provider row", {
        vendorId: session.vendorId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private interactionFor(session: LoginSession): AuthInteraction {
    return {
      signal: session.controller.signal,
      prompt: (prompt) => this.ask(session, prompt),
      notify: (event) => this.notify(session, event),
    };
  }

  private ask(session: LoginSession, prompt: AuthPrompt): Promise<string> {
    const promptId = this.nextId();
    return new Promise<string>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      const settle = () => {
        session.prompts.delete(promptId);
        for (const cleanup of cleanups) cleanup();
      };
      const entry: PendingPrompt = {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      session.prompts.set(promptId, entry);

      // The flow cancels a prompt when it answers the step itself — a callback
      // that beats the paste box — so the renderer has to close that input.
      const abort = () => {
        this.push(session, { kind: "promptCancelled", promptId });
        entry.reject(new Error("prompt cancelled"));
      };
      for (const signal of [prompt.signal, session.controller.signal]) {
        if (!signal) continue;
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", abort));
      }

      this.push(session, {
        kind: "prompt",
        request: promptRequest(promptId, prompt),
      });
    });
  }

  private notify(session: LoginSession, event: AuthEvent): void {
    switch (event.type) {
      case "info":
        this.push(session, {
          kind: "info",
          message: event.message,
          links: event.links?.map((link) => ({
            url: link.url,
            label: link.label,
          })),
        });
        return;
      case "auth_url":
        this.pushAuthUrl(session, event.url, event.instructions);
        return;
      case "device_code":
        this.push(session, {
          kind: "deviceCode",
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          intervalSeconds: event.intervalSeconds,
          expiresInSeconds: event.expiresInSeconds,
        });
        return;
      case "progress":
        this.push(session, { kind: "progress", message: event.message });
    }
  }

  private pushAuthUrl(
    session: LoginSession,
    url: string,
    instructions?: string,
  ): void {
    session.tail = session.tail.then(async () => {
      // Report whether the browser actually opened: when it did not, the
      // renderer has to offer the link for copying instead.
      const opened = await this.deps.openExternal(url).then(
        () => true,
        () => false,
      );
      this.deps.emit({
        loginId: session.loginId,
        vendorId: session.vendorId,
        kind: "authUrl",
        url,
        instructions,
        opened,
      });
    });
  }

  private push(session: LoginSession, event: OAuthEventBody): void {
    session.tail = session.tail.then(() => {
      this.deps.emit({
        ...event,
        loginId: session.loginId,
        vendorId: session.vendorId,
      } as OAuthLoginEvent);
    });
  }

  private async ensureCatalogModels(): Promise<MutableModels> {
    this.catalogPromise ??= Promise.resolve(
      this.createModels(this.emptyCredentials),
    );
    return this.catalogPromise;
  }

  private createModels(credentials: CredentialStore): MutableModels {
    if (this.deps.createModels) return this.deps.createModels(credentials);
    // pi-ai loads each flow through a variable import specifier so bundlers
    // cannot follow it into Node-only code; registering the static set keeps
    // login working in the packaged app. Named for the Bun binary, but the
    // flows themselves are plain Node.
    if (!this.oauthFlowsRegistered) {
      registerBunOAuthFlows();
      this.oauthFlowsRegistered = true;
    }
    return builtinModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
      modelsStore: new InMemoryModelsStore(),
    });
  }

  private createAccount(vendorId: string, providerId: string): AccountModels {
    const existing = this.accountModels.get(providerId);
    if (existing) return existing;
    const account: AccountModels = {
      providerId,
      vendorId,
      models: this.createModels(this.credentialsFor(providerId, vendorId)),
    };
    const original = account.models.getProvider(vendorId);
    account.pinnedProvider = original;
    if (original && vendorId !== "radius") {
      let offered: Model<Api>[] | undefined;
      account.models.setProvider({
        ...original,
        getModels: () => offered ?? original.getModels(),
        getAllModels: () => [...(offered ?? original.getModels()), ...(original.getAllModels?.() ?? []).filter(model => model.type && model.type !== "chat")],
        // The successful live list is the account's entitlement authority.
        filterModels: (models, credential) => offered ? models : original.filterModels?.(models, credential) ?? models,
        refreshModels: async context => {
          await original.refreshModels?.(context);
          if (!context.allowNetwork) return;
          context.signal.throwIfAborted();
          if (context.force) this.liveModelCache.delete(providerId);
          const live = await this.withRowHeaders(providerId, () => this.liveAccountModels(account));
          if (!live) return;
          const projected = await Promise.all(live.map(async option => {
            const config = withMappedThinkingLevels(await this.deps.modelConfigFor?.({
              providerId,
              vendorKey: account.vendorId,
              option,
            }).catch(() => undefined) ?? genericModelConfig(option.modelId, option.baseUrl));
            return {
              ...config, id: option.modelId, provider: vendorId,
              api: wireApiForStyle(option.apiStyle), baseUrl: option.baseUrl,
              // Generic limits and zero-price defaults are not published data.
              cost: config.source === "generic"
                ? { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN }
                : config.cost ?? { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
            } as Model<Api>;
          }));
          context.signal.throwIfAborted();
          await context.publish({ update: () => { offered = projected; } });
        },
      });
    }
    this.accountModels.set(providerId, account);
    this.deps.onAccountModels?.(providerId, account.models);
    return account;
  }

  private async withRowHeaders<T>(
    providerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const row = (await this.rows()).find((candidate) => candidate.id === providerId);
    return await runWithProviderHeaders(row?.headers, fn);
  }

  private async accountForProvider(
    providerId: string,
  ): Promise<AccountModels | undefined> {
    const row = (await this.rows()).find(
      (candidate) =>
        candidate.id === providerId &&
        candidate.authKind === OAUTH_AUTH_KIND &&
        typeof candidate.vendorKey === "string" &&
        candidate.vendorKey.length > 0,
    );
    return row?.vendorKey
      ? this.createAccount(row.vendorKey, row.id)
      : undefined;
  }

  /**
   * Create a store scoped to one provider row. pi-ai still addresses the
   * credential by its builtin vendor id, while the app maps that id to the
   * row-specific encrypted secret ref.
   */
  private credentialsFor(
    providerId: string,
    vendorId: string,
  ): CredentialStore {
    return {
      read: (requestedVendorId) => {
        if (requestedVendorId !== vendorId) return Promise.resolve(undefined);
        return this.readCredential(providerId);
      },
      list: async () => {
        const row = (await this.rows()).find(
          (candidate) => candidate.id === providerId,
        );
        return row?.authKind === OAUTH_AUTH_KIND && row.hasOauth
          ? [{ providerId: vendorId, type: "oauth" }]
          : [];
      },
      modify: (requestedVendorId, fn) => {
        if (requestedVendorId !== vendorId) {
          throw new Error(`provider is not part of account ${providerId}`);
        }
        return this.serialize(providerId, async () => {
          const current = await this.readCredential(providerId);
          const next = await fn(current);
          if (next === undefined) return current;
          await this.deps.call("secrets.set", {
            secretRef: secretRefForProviderOauth(providerId),
            value: JSON.stringify(next),
          });
          return next;
        });
      },
      delete: (requestedVendorId) => {
        if (requestedVendorId !== vendorId) {
          throw new Error(`provider is not part of account ${providerId}`);
        }
        return this.serialize(providerId, async () => {
          await this.deps.call("secrets.delete", {
            secretRef: secretRefForProviderOauth(providerId),
          });
        });
      },
    };
  }

  private readonly emptyCredentials: CredentialStore = {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => undefined,
  };

  private async readCredential(
    providerId: string,
  ): Promise<Credential | undefined> {
    const { value } = await this.deps.call<{ value?: string | null }>(
      "secrets.getForRuntime",
      { secretRef: secretRefForProviderOauth(providerId) },
    );
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as Credential;
      return parsed?.type ? parsed : undefined;
    } catch {
      this.log("warn", "stored vendor credential is not readable", { providerId });
      return undefined;
    }
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async rows(): Promise<OAuthProviderRow[]> {
    const result = await this.deps.call<{ providers?: OAuthProviderRow[] }>(
      "providers.list",
      { includeDisabled: true },
    );
    return result.providers ?? [];
  }

  private nextId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  private log(
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.deps.log?.(level, message, data);
  }
}
