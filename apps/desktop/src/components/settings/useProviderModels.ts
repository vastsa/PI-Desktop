/**
 * Live model discovery for the provider forms.
 *
 * The AI service itself is the authority on which models it serves, so this
 * hook asks the service's own endpoint (through `api.listProviderModels`) while
 * the form is edited. models.dev only enriches what came back; the host reports
 * where the list originated through `source`.
 */
import { useEffect, useRef, useState } from "react";
import type { ModelInfo, ProviderPublic } from "@pi-desktop/shared";
import { api } from "../../lib/api";

/** Where the returned list came from, as reported by the host. */
export type ProviderModelsSource = "cache" | "remote" | "catalog" | "fallback";

export type ProviderModelsState = {
  status: "idle" | "loading" | "ready" | "error";
  models: ModelInfo[];
  /** Message from the failed live call; cached rows stay visible alongside it. */
  error?: string;
  source?: ProviderModelsSource;
};

export type ProviderModelsDiscovery = ProviderModelsState & {
  /** Probe the live endpoint now. Skips debounce and the cache-first paint. */
  reload: () => void;
  /**
   * True when a live probe can start now. Idle-with-a-valid-URL (the edit
   * debounce) is included so Fetch list can skip that window.
   */
  canReload: boolean;
};

/** Keystroke settling window before the service is contacted. */
const FETCH_DEBOUNCE_MS = 600;

const IDLE: ProviderModelsState = { status: "idle", models: [] };

function canDiscover(baseUrl: string): boolean {
  try {
    new URL(baseUrl.trim());
  } catch {
    return false;
  }
  // Discovery is also useful for local/no-auth gateways, so an API key is never
  // required here. A provider can still answer with an auth error, which leaves
  // the custom-model path available. Named add-path gating happens at the call
  // site via `active`.
  return true;
}

/**
 * Discover the models a service publishes while its form is edited.
 *
 * Debounced on baseUrl/apiKey/apiStyle. Loading is not painted until that
 * window elapses, so typing a key or picking a service does not re-render the
 * panes on every change. A saved provider paints its cached list first and
 * then refreshes live; the stored secret is reused when no key is typed (the
 * main process reads the keychain for `providerId`). A header action can probe
 * immediately without waiting for that window or painting cache first.
 */
export function useProviderModels(
  active: boolean,
  form: { baseUrl: string; apiKey: string; apiStyle: string; headers?: Record<string, string> },
  editingProvider?: ProviderPublic | null,
): ProviderModelsDiscovery {
  const [state, setState] = useState<ProviderModelsState>(IDLE);
  // Only the newest request may commit: a slow reply from an older keystroke
  // must never overwrite a newer result.
  const requestSeq = useRef(0);
  const endpointRef = useRef<string | null>(null);

  const { baseUrl, apiKey, apiStyle, headers } = form;
  const headersKey = JSON.stringify(headers ?? {});
  const providerId = editingProvider?.id;
  const paramsRef = useRef({ active, baseUrl, apiKey, apiStyle, headers, providerId });
  paramsRef.current = { active, baseUrl, apiKey, apiStyle, headers, providerId };
  const modelsRef = useRef(state.models);
  modelsRef.current = state.models;

  const run = async (requestId: number, options?: { skipCache?: boolean }) => {
    const {
      active: isActive,
      baseUrl: url,
      apiKey: key,
      apiStyle: style,
      headers: hdrs,
      providerId: id,
    } = paramsRef.current;
    if (requestSeq.current !== requestId) return;
    if (!isActive || !canDiscover(url)) {
      setState(IDLE);
      return;
    }
    setState((prev) => ({ status: "loading", models: prev.models }));

    let cachedModels: ModelInfo[] = options?.skipCache ? modelsRef.current : [];
    if (id && !options?.skipCache) {
      try {
        const cached = await api.listProviderModels({
          providerId: id,
          source: "cache",
        });
        if (requestSeq.current !== requestId) return;
        cachedModels = cached.models;
        if (cachedModels.length > 0) {
          // Paint the known list instantly; the live answer replaces it.
          setState({
            status: "loading",
            models: cachedModels,
            source: cached.source,
          });
        }
      } catch {
        // Live discovery remains available when the local cache read fails.
      }
    }

    try {
      // No `source` field: that is what selects the live branch in the host
      // handler, which asks the service first and models.dev only after.
      const result = await api.listProviderModels({
        ...(id ? { providerId: id } : {}),
        baseUrl: url.trim(),
        ...(key ? { apiKey: key } : {}),
        apiStyle: style,
        ...(Object.keys(hdrs ?? {}).length > 0 ? { headers: hdrs } : {}),
      });
      if (requestSeq.current !== requestId) return;
      if (result.models.length > 0) {
        setState({
          status: "ready",
          models: result.models,
          source: result.source,
          ...(result.error ? { error: result.error } : {}),
        });
      } else {
        // An empty live result keeps the cached rows usable and reports why.
        setState({
          status: "error",
          models: cachedModels,
          source: result.source,
          ...(result.error ? { error: result.error } : {}),
        });
      }
    } catch (cause) {
      if (requestSeq.current !== requestId) return;
      setState({
        status: "error",
        models: cachedModels,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  useEffect(() => {
    const endpoint = `${baseUrl.trim()}|${apiStyle}`;
    const first = endpointRef.current === null;
    const endpointChanged = !first && endpointRef.current !== endpoint;
    endpointRef.current = endpoint;

    if (!active || !canDiscover(baseUrl)) {
      requestSeq.current += 1;
      setState(IDLE);
      return;
    }

    const requestId = ++requestSeq.current;
    if (endpointChanged) setState(IDLE);

    // An existing provider opens with a known-good config — fetch right away
    // unless the endpoint itself just changed.
    const immediate = !!providerId && !apiKey && !endpointChanged;
    const timer = setTimeout(() => void run(requestId), immediate ? 0 : FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, baseUrl, apiKey, apiStyle, headersKey, providerId]);

  const reload = () => {
    if (!paramsRef.current.active || !canDiscover(paramsRef.current.baseUrl)) return;
    const requestId = ++requestSeq.current;
    void run(requestId, { skipCache: true });
  };

  const canReload =
    active && canDiscover(baseUrl) && state.status !== "loading";

  return { ...state, reload, canReload };
}
