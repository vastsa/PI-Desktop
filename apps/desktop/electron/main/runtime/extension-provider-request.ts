/**
 * Transport for the trusted-extension provider request surface (plan S2,
 * decisions D3–D8).
 *
 * One call, one destination: the provider row the caller named supplies the
 * origin (D4) and the credential (D5); the caller supplies the path and the
 * envelope; main supplies the transport policy — no redirects, no automatic
 * retry, a bounded budget, bounded bodies, an abort registry, and one audit row.
 *
 * The gate that decides *whether* a call may happen lives in
 * `extension-provider-access.ts`; this module is handed a subject that has
 * already been authorized, and never reads the wire for identity.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { createContainedFileReader } from "../services/contained-file-reader";
import type { HostProcess } from "../host-process";
import { modelIdsMatch, type ProviderPublic } from "@pi-desktop/shared";
import {
  mergeProviderHeaders,
  type ExtensionProviderRequestResult,
} from "@pi-desktop/agent-runtime";
import {
  MULTIPART_FILE_MAX_BYTES,
  MULTIPART_TOTAL_MAX_BYTES,
  assembleRequestBody,
  callerHeaders,
  requestError,
  requestErrorCode,
  requestMethod,
  requestTimeoutMs,
  resolveRequestUrl,
} from "./extension-request-envelope";
import {
  type ProviderRequestAuditEntry,
  providerRequestAudit,
  responseResult,
} from "./extension-request-response";

/** Who the call is for, as main decided it (plan D7). */
export type ProviderRequestSubject = {
  sessionId: string;
  /** The project this session owns, as main recorded it at launch. */
  projectPath?: string;
  /** The contributing plugins whose grants the gate accepted, for the audit row. */
  pluginIds: string[];
  /** The plugin that owns the claimed extension: the brake is charged to it. */
  pluginId: string;
  /** The claimed extension id; attribution only. */
  extensionId: string;
  callId: string;
};

export type ExtensionProviderRequestHandler = {
  perform(
    params: Record<string, unknown>,
    subject: ProviderRequestSubject,
    /**
     * `charge` is called once the request is about to leave, never before: a
     * call this transport refuses on its own (a bad argument, an unavailable
     * provider, an unreadable upload) never reached the provider, so it must not
     * spend the plugin's allowance (plan D8).
     */
    hooks?: { charge?: () => void },
  ): Promise<ExtensionProviderRequestResult>;
  /** `extensions.providers.abort`: cancel one in-flight call by its id. */
  abort(params: unknown): { ok: boolean };
  /** Runtime disposal: nothing this handler started may outlive it (D8). */
  abortAll(): void;
};

export type ExtensionProviderRequestOptions = {
  getHost: () => Pick<HostProcess, "call"> | null;
  dataDir: string;
  fetchImpl?: typeof fetch;
  audit: (entry: Record<string, unknown>) => void;
};

type CredentialHeader = { name: string; value: string };

/** The `apiStyle` → credential-header mapping the runtime's adapters use. */
function credentialHeaderFor(
  apiStyle: string | undefined,
  secret: string,
): CredentialHeader {
  if (apiStyle === "anthropic_messages") {
    return { name: "x-api-key", value: secret };
  }
  if (apiStyle === "google_generative_ai") {
    return { name: "x-goog-api-key", value: secret };
  }
  return { name: "authorization", value: `Bearer ${secret}` };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A `[A-Z0-9_]{1,32}` failure code, or "" when the failure carries none. */
function codeOf(value: unknown): string {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "";
}

function abortKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

/** True when `target` sits strictly inside `base`; the shipped root rule. */
function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Is `modelId` one of the provider's own models? The row's `defaultModelId` is
 * accepted too: the catalogue this surface pairs with still advertises it when a
 * row carries no model list, and a model the extension can read from the host
 * must not be a model the host then refuses (`@deprecated`, but still projected).
 */
function modelIsConfigured(provider: ProviderPublic, modelId: string): boolean {
  if (provider.models?.some((binding) => modelIdsMatch(binding.id, modelId))) {
    return true;
  }
  return !!provider.defaultModelId && modelIdsMatch(provider.defaultModelId, modelId);
}

/**
 * The transport failure, reduced to a code. The message deliberately carries no
 * URL and no header value: a caller's query string and the provider's address
 * are not the host's to write into a log line, and a resolver error code is
 * enough to diagnose a failure.
 */
function transportError(
  error: unknown,
  state: { timedOut: boolean; aborted: boolean },
): Error {
  if (state.timedOut) {
    return requestError("TIMEOUT", "The provider request exceeded its budget");
  }
  if (state.aborted) {
    return requestError("ABORTED", "The provider request was aborted");
  }
  // A host code already decided (an oversized response, a rejected upload) is
  // not a transport failure and keeps the code the caller needs.
  if (typeof (error as { errorCode?: unknown } | null)?.errorCode === "string") {
    return error as Error;
  }
  const code = codeOf((error as { cause?: unknown } | null)?.cause);
  return requestError(
    "NETWORK_ERROR",
    code
      ? `The provider request failed (${code})`
      : "The provider request failed",
  );
}

export function createExtensionProviderRequest(
  options: ExtensionProviderRequestOptions,
): ExtensionProviderRequestHandler {
  const inFlight = new Map<string, AbortController>();
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));

  /**
   * A host round trip. A failure that carries no code is the host not being
   * there — an unavailable host must reach the extension as a code too, not as a
   * bare message only a log can explain.
   */
  const callHost = async <T>(
    host: Pick<HostProcess, "call">,
    method: string,
    params: unknown,
  ): Promise<T> => {
    try {
      return await host.call<T>(method, params);
    } catch (error) {
      if (typeof (error as { errorCode?: unknown } | null)?.errorCode === "string") {
        throw error;
      }
      throw requestError("HOST_UNAVAILABLE", `The ${method} lookup failed`);
    }
  };

  /** The provider row and the credential, or the code that refuses the call (D5). */
  const resolveProvider = async (
    host: Pick<HostProcess, "call">,
    providerId: string,
    modelId: string,
  ): Promise<{ provider: ProviderPublic; credential?: CredentialHeader }> => {
    const { provider } = await callHost<{ provider?: ProviderPublic }>(
      host,
      "providers.get",
      { id: providerId },
    );
    if (!provider || provider.enabled === false || !provider.baseUrl) {
      throw requestError(
        "PROVIDER_NOT_FOUND",
        `provider "${providerId}" is not available`,
      );
    }
    if (modelId && !modelIsConfigured(provider, modelId)) {
      throw requestError(
        "MODEL_NOT_CONFIGURED",
        `model "${modelId}" is not configured on provider "${provider.id}"`,
      );
    }
    // v1 excludes vendor accounts: their wire endpoint is model-dependent, so
    // `baseUrl` alone does not identify the destination (D5).
    if (provider.authKind === "oauth") {
      throw requestError(
        "PROVIDER_AUTH_UNSUPPORTED",
        "Vendor-account (OAuth) providers are not supported by this API",
      );
    }
    if (provider.authKind === "none") return { provider };
    const { value } = await callHost<{ value?: string }>(
      host,
      "providers.getSecret",
      { id: provider.id },
    );
    if (!value) {
      throw requestError(
        "PROVIDER_AUTH_MISSING",
        `provider "${provider.id}" has no stored credential`,
      );
    }
    return {
      provider,
      credential: credentialHeaderFor(provider.apiStyle, value),
    };
  };

  /**
   * Uploaded files resolve against roots the host captured — the session's
   * project, the session's scratch directory, and the attachment store — never
   * against a path the caller supplied (D3). The reader is the shipped
   * containment rule with this surface's caps.
   */
  const fileReaderFor = (
    host: Pick<HostProcess, "call">,
    subject: ProviderRequestSubject,
  ): ((refs: string[]) => Promise<Uint8Array[]>) => {
    let reader: ((refs: string[]) => Promise<Uint8Array[]>) | undefined;
    return async (refs: string[]) => {
      if (refs.length === 0) return [];
      if (!reader) {
        const scratch = await callHost<{ path?: string }>(
          host,
          "session.getScratchPath",
          { sessionId: subject.sessionId },
        );
        const root = typeof scratch?.path === "string" ? scratch.path : "";
        // Fail closed. Falling back to the app data directory would make every
        // transcript, log, and provider secret the app stores readable through
        // `multipart.files`, so an answer that is not the session's own scratch
        // directory refuses the upload instead of widening the roots.
        if (!root || !within(resolve(options.dataDir, "scratch"), resolve(root))) {
          throw requestError(
            "INVALID_ARGUMENT",
            "The session scratch directory is not usable",
          );
        }
        reader = createContainedFileReader({
          roots: {
            ...(subject.projectPath ? { projectPath: subject.projectPath } : {}),
            scratchPath: root,
            dataDir: options.dataDir,
          },
          maxFileBytes: MULTIPART_FILE_MAX_BYTES,
          maxSetBytes: MULTIPART_TOTAL_MAX_BYTES,
          maxBudgetBytes: MULTIPART_TOTAL_MAX_BYTES,
          codes: {
            outside: "FILE_OUTSIDE_ALLOWED_ROOTS",
            notFound: "FILE_NOT_FOUND",
            // "does not exist" and "is not a regular file" share the code the
            // documented error table gives them.
            invalid: "FILE_NOT_FOUND",
            fileTooLarge: "FILE_TOO_LARGE",
            setTooLarge: "UPLOAD_TOO_LARGE",
          },
        });
      }
      try {
        return await reader(refs);
      } catch (error) {
        // The reader codes every failure it decides; anything left is a plain
        // filesystem error (a locked or unreadable file), which still has to
        // reach the caller as a code rather than as a bare message.
        if (typeof (error as { errorCode?: unknown } | null)?.errorCode === "string") {
          throw error;
        }
        const code = codeOf(error);
        throw requestError(
          "INVALID_ARGUMENT",
          code
            ? `An uploaded file could not be read (${code})`
            : "An uploaded file could not be read",
        );
      }
    };
  };

  const perform = async (
    params: Record<string, unknown>,
    subject: ProviderRequestSubject,
    hooks?: { charge?: () => void },
  ): Promise<ExtensionProviderRequestResult> => {
    const startedAt = Date.now();
    // Every call leaves exactly one row, including a call refused before any
    // I/O — a mistake must be as visible as a failure. Fields are filled in as
    // the call learns them, so a refusal still names what it was asked for.
    const row: ProviderRequestAuditEntry = {
      ok: false,
      sessionId: subject.sessionId,
      pluginIds: subject.pluginIds,
      pluginId: subject.pluginId,
      extensionId: subject.extensionId,
      ts: Date.now(),
    };
    const writeRow = (): void => {
      row.ts = Date.now();
      options.audit(providerRequestAudit(row));
    };
    const fail = (error: unknown): never => {
      row.errorCode = requestErrorCode(error, "INTERNAL");
      const data = (error as { data?: { status?: unknown; bytes?: unknown } } | null)
        ?.data;
      if (typeof data?.status === "number") row.status = data.status;
      if (typeof data?.bytes === "number") row.responseBytes = data.bytes;
      row.durationMs = Date.now() - startedAt;
      writeRow();
      throw error;
    };

    try {
      // Cheap, purely local validation first: a caller's mistake costs no I/O.
      const host = options.getHost();
      if (!host) throw requestError("UNSUPPORTED", "The host is unavailable");
      const providerId = asString(params.providerId);
      if (providerId) row.providerId = providerId;
      if (!providerId) {
        throw requestError("INVALID_ARGUMENT", "providerId is required");
      }
      const modelId = asString(params.modelId);
      if (modelId) row.modelId = modelId;
      const method = requestMethod(params.method);
      row.method = method;
      const timeoutMs = requestTimeoutMs(params.timeoutMs);
      const headers = callerHeaders(params.headers);

      // The budget and the abort registry start here rather than at the fetch:
      // `timeoutMs` is the wall time the caller allowed for the whole call, and
      // an abort that lands while main is still resolving the provider or
      // reading an upload has to be honored instead of outrun (plan D8).
      const controller = new AbortController();
      const key = abortKey(subject.sessionId, subject.callId);
      inFlight.set(key, controller);
      // One mutable record, so the timer and the failure mapping read the same
      // fact: a budget that expired is `TIMEOUT`, anything else that stopped the
      // request early is `ABORTED`.
      const transport = { timedOut: false };
      const timer = setTimeout(() => {
        transport.timedOut = true;
        controller.abort();
      }, timeoutMs);
      const stopped = (): Error =>
        transport.timedOut
          ? requestError("TIMEOUT", "The provider request exceeded its budget")
          : requestError("ABORTED", "The provider request was aborted");
      try {
        const { provider, credential } = await resolveProvider(
          host,
          providerId,
          modelId,
        );
        row.providerId = provider.id;
        const url = resolveRequestUrl(provider.baseUrl, params.path);
        // The final path without its query is the audit anchor (plan D10): the
        // query can carry a secret, the path is where the call went.
        row.path = new URL(url).pathname;
        const body = await assembleRequestBody({
          body: params.body,
          method,
          readFiles: fileReaderFor(host, subject),
        });
        // A caller that gave up during pre-flight is answered here: nothing may
        // be sent after an abort, and a budget that expired covers the whole
        // call, not only the fetch.
        if (controller.signal.aborted) throw stopped();
        // The brake is charged when the request is about to leave, so a refusal
        // this transport decides never spends the plugin's allowance (D8).
        hooks?.charge?.();

        // Provider-configured headers first, then the caller's under the shared
        // provider-header caps, then the credential last so it always wins (D5).
        const composed = mergeProviderHeaders(provider.headers, headers) ?? {};
        const finalHeaders = new Headers(composed);
        if (credential) finalHeaders.set(credential.name, credential.value);
        if (body.contentType) finalHeaders.set("content-type", body.contentType);

        let response: Response;
        try {
          response = await fetchImpl(url, {
            method,
            headers: finalHeaders,
            // A redirect is never followed: the credential must not be re-sent
            // to a host the provider row did not name (D6).
            redirect: "manual",
            signal: controller.signal,
            ...(body.body !== undefined ? { body: body.body } : {}),
          });
        } catch (error) {
          throw transportError(error, {
            timedOut: transport.timedOut,
            aborted: !transport.timedOut && controller.signal.aborted,
          });
        }
        let result: ExtensionProviderRequestResult;
        try {
          result = await responseResult({
            response,
            ...(credential ? { credentialsHeader: credential.name } : {}),
            startedAt,
          });
        } catch (error) {
          throw transportError(error, {
            timedOut: transport.timedOut,
            aborted: !transport.timedOut && controller.signal.aborted,
          });
        }
        row.ok = true;
        row.status = result.status;
        row.durationMs = result.durationMs;
        row.requestBytes = body.bytes;
        row.responseBytes = result.body.bytes;
        if (body.files !== undefined) row.files = body.files;
        writeRow();
        return result;
      } finally {
        clearTimeout(timer);
        inFlight.delete(key);
      }
    } catch (error) {
      return fail(error);
    }
  };

  return {
    perform,
    abort(params) {
      const sessionId = asString((params as { sessionId?: unknown })?.sessionId);
      const callId = asString((params as { callId?: unknown })?.callId);
      if (!sessionId || !callId) return { ok: false };
      const controller = inFlight.get(abortKey(sessionId, callId));
      if (!controller) return { ok: false };
      controller.abort();
      return { ok: true };
    },
    abortAll() {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    },
  };
}
