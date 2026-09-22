/**
 * Policy layer for the trusted-extension host-proxy methods (plan S1/S2, D7/D8).
 *
 * The subject of every call is resolved from state main owns — the
 * session→project map main populated at launch plus the loaded-plugin registry —
 * never from the wire. The wire carries a session id, a *claimed* `extensionId`,
 * and a `callId`; only the first two are used to decide, and the claimed id must
 * belong to the session's loaded extension set before anything is read or sent.
 *
 * Two plugins contributing extensions to one session cannot be told apart at
 * runtime (their modules share one process), so a grant check is the **union of
 * the contributing plugins' grants**. That residual limit is recorded in the
 * plan (D7) and is why the real force is install-time consent, per-call audit,
 * a shared rate brake, and an in-flight cap rather than isolation.
 */
import type {
  ExtensionProviderRequestResult,
  HostModelDescriptor,
} from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import type { ExtensionModelCatalog } from "./extension-model-catalog";
import { requestErrorCode } from "./extension-request-envelope";
import {
  type ExtensionProviderRequestHandler,
  type ProviderRequestSubject,
} from "./extension-provider-request";
import { providerRequestAudit } from "./extension-request-response";

/** The permission a plugin must hold for its extensions to read the catalogue. */
const MODELS_LIST_PERMISSION = "models.list";
/**
 * The permission a plugin must hold for its extensions to issue a provider
 * request (plan D7). It reaches the whole provider API surface with the user's
 * credential — any path, any method — so it is its own high-risk grant.
 */
const PROVIDER_REQUEST_PERMISSION = "provider.request";

/** Audit operation names; each matches the permission its call is gated by. */
const CATALOGUE_AUDIT_API = "models.list";

/** D8: at most four calls per plugin in flight, so a fan-out cannot pile up. */
const MAX_IN_FLIGHT_PER_PLUGIN = 4;

export type ExtensionProviderAccess = {
  listProviderModels(params: unknown): Promise<{ models: HostModelDescriptor[] }>;
  requestProvider(params: unknown): Promise<ExtensionProviderRequestResult>;
  abortProviderRequest(params: unknown): { ok: boolean };
  /** Runtime disposal: every call this layer started is aborted (plan D8). */
  abortAllProviderRequests(): void;
};

export type ExtensionProviderAccessOptions = {
  catalog: ExtensionModelCatalog;
  providerRequest: ExtensionProviderRequestHandler;
  getHost: () => Pick<HostProcess, "call"> | null;
  activeInProject: (pluginId: string, projectPath: string | null) => boolean;
  /** Same sink shape as the plugin host services' audit callback. */
  audit: (entry: Record<string, unknown>) => void;
  /**
   * The rate brake, shared with the plugin host's `agent.complete` counter
   * (D8): one spend surface per plugin must not buy two budgets by alternating
   * calls. Returns false when the plugin is over the window.
   */
  consumeRequestBudget: (pluginId: string) => boolean;
  plugins: {
    getAgentExtensions(): Array<{ pluginId: string; id: string }>;
    pluginHasPermission(pluginId: string, permission: string): boolean;
  };
  /**
   * The project each live session owns, as main recorded it at launch. The wire
   * names a session id; only an id in this map has a known project.
   */
  sessionProjects: Map<string, string | null>;
};

/** A session id is the only identity the wire carries for the subject. */
function sessionIdOf(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const value = (params as { sessionId?: unknown }).sessionId;
  return typeof value === "string" ? value.trim() : "";
}

function callIdOf(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const value = (params as { callId?: unknown }).callId;
  return typeof value === "string" ? value.trim() : "";
}

function extensionIdOf(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const value = (params as { extensionId?: unknown }).extensionId;
  return typeof value === "string" ? value.trim() : "";
}

function denied(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

export function createExtensionProviderAccess(
  options: ExtensionProviderAccessOptions,
): ExtensionProviderAccess {
  const {
    catalog,
    providerRequest,
    getHost,
    activeInProject,
    audit,
    consumeRequestBudget,
    plugins,
    sessionProjects,
  } = options;

  /** D8's in-flight cap, counted per owning plugin. */
  const inFlight = new Map<string, number>();

  /**
   * Resolve the subject from main-owned state, or the code that refuses the
   * call. Both host-proxy methods share it: an unknown session is refused
   * before any catalogue read or provider lookup, and each method names the
   * grant it needs.
   */
  const resolveSubject = (
    params: unknown,
    permission: string,
  ):
    | {
        sessionId: string;
        projectPath: string | null;
        pluginIds: string[];
        contributing: Array<{ pluginId: string; id: string }>;
      }
    | { denied: Error; sessionId: string; pluginIds: string[] } => {
    const sessionId = sessionIdOf(params);
    const host = getHost();
    if (!host || !sessionId || !sessionProjects.has(sessionId)) {
      return {
        denied: denied("PERMISSION_DENIED", "No session owns this call"),
        sessionId,
        pluginIds: [],
      };
    }
    const projectPath = sessionProjects.get(sessionId) ?? null;
    const contributing = plugins
      .getAgentExtensions()
      .filter((extension) => activeInProject(extension.pluginId, projectPath));
    const pluginIds = [...new Set(contributing.map((e) => e.pluginId))];
    if (
      !contributing.some((extension) =>
        plugins.pluginHasPermission(extension.pluginId, permission),
      )
    ) {
      return {
        denied: denied("PERMISSION_DENIED", `The ${permission} grant is missing`),
        sessionId,
        pluginIds,
      };
    }
    return { sessionId, projectPath, pluginIds, contributing };
  };

  /** One audited refusal, then the same code to the caller. */
  const refuse = (
    sessionId: string,
    pluginIds: string[],
    error: Error,
  ): never => {
    audit(
      providerRequestAudit({
        ok: false,
        sessionId,
        pluginIds,
        ts: Date.now(),
        errorCode: requestErrorCode(error),
      }),
    );
    throw error;
  };

  const listProviderModels = async (
    params: unknown,
  ): Promise<{ models: HostModelDescriptor[] }> => {
    const subject = resolveSubject(params, MODELS_LIST_PERMISSION);
    if ("denied" in subject) {
      audit({
        api: CATALOGUE_AUDIT_API,
        ok: false,
        errorCode: "PERMISSION_DENIED",
        count: 0,
        sessionId: subject.sessionId,
        pluginIds: subject.pluginIds,
        ts: Date.now(),
      });
      return { models: [] };
    }
    const { sessionId, pluginIds } = subject;
    // A catalogue failure rejects the call instead of answering "no models":
    // an unreachable host and a host with no ready models must not look alike.
    // The rejected call is still audited, so a granted-then-failed call leaves
    // a trace.
    let models: HostModelDescriptor[];
    try {
      models = await catalog.listReadyModels();
    } catch (error) {
      audit({
        api: CATALOGUE_AUDIT_API,
        ok: false,
        errorCode: "UNSUPPORTED",
        count: 0,
        sessionId,
        pluginIds,
        ts: Date.now(),
      });
      throw error;
    }
    audit({
      api: CATALOGUE_AUDIT_API,
      ok: true,
      count: models.length,
      sessionId,
      pluginIds,
      ts: Date.now(),
    });
    return { models };
  };

  const requestProvider = async (
    params: unknown,
  ): Promise<ExtensionProviderRequestResult> => {
    const subject = resolveSubject(params, PROVIDER_REQUEST_PERMISSION);
    if ("denied" in subject) {
      return refuse(subject.sessionId, subject.pluginIds, subject.denied);
    }
    const { sessionId, projectPath, pluginIds, contributing } = subject;

    const extensionId = extensionIdOf(params);
    const claimed = contributing.find((extension) => extension.id === extensionId);
    // The claimed id must belong to the session's loaded set: an id from
    // nowhere is not an identity, and the audit line names only real plugins.
    if (!claimed) {
      return refuse(
        sessionId,
        pluginIds,
        denied("PERMISSION_DENIED", "Unknown extension id for this session"),
      );
    }
    const callId = callIdOf(params);
    if (!callId) {
      return refuse(
        sessionId,
        pluginIds,
        denied("INVALID_ARGUMENT", "callId is required"),
      );
    }
    // The in-flight cap is checked first, and the brake is charged by the
    // transport once the request is about to leave (D8): a call refused for
    // congestion or for a rejected argument never reached the provider, so it
    // must not also spend the plugin's allowance.
    const owner = claimed.pluginId;
    if ((inFlight.get(owner) ?? 0) >= MAX_IN_FLIGHT_PER_PLUGIN) {
      return refuse(
        sessionId,
        pluginIds,
        denied(
          "RATE_LIMITED",
          "Too many provider requests are already in flight for this plugin",
        ),
      );
    }

    inFlight.set(owner, (inFlight.get(owner) ?? 0) + 1);
    try {
      // The transport audits its own outcome (one row per call, including the
      // refusals it decides), so this layer only releases the slot. Both the
      // brake and the slot follow the *claimed* extension's plugin — a module of
      // one plugin can therefore spend a sibling's allowance by naming its
      // extension, because two contributing plugins share one sidecar process
      // and cannot be told apart at runtime. That is the recorded
      // union-of-grants residual (D7), not isolation.
      return await providerRequest.perform(
        params as Record<string, unknown>,
        {
          sessionId,
          ...(projectPath ? { projectPath } : {}),
          pluginIds,
          pluginId: owner,
          extensionId,
          callId,
        } satisfies ProviderRequestSubject,
        {
          charge: () => {
            if (consumeRequestBudget(owner)) return;
            throw denied(
              "RATE_LIMITED",
              "The provider request rate limit was reached",
            );
          },
        },
      );
    } finally {
      const remaining = (inFlight.get(owner) ?? 1) - 1;
      if (remaining > 0) inFlight.set(owner, remaining);
      else inFlight.delete(owner);
    }
  };
  return {
    listProviderModels,
    requestProvider,
    // Aborting is a side channel, not a call the surface reports on: it is
    // answered by the transport and never audited as a request of its own. The
    // session id still has to be one main owns, so an id from nowhere cannot
    // reach a live session's in-flight call.
    abortProviderRequest: (params) => {
      const sessionId = sessionIdOf(params);
      if (!sessionId || !sessionProjects.has(sessionId)) return { ok: false };
      return providerRequest.abort(params);
    },
    abortAllProviderRequests: () => {
      // The per-plugin counts are deliberately left alone: every running call
      // releases its own slot in its `finally`, and clearing them here would let
      // a call that is still winding down decrement a slot a newer call holds.
      providerRequest.abortAll();
    },
  };
}
