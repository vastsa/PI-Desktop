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
  // the custom-model path available.
  return true;
}

/**
 * Discover the models a service publishes while its form is edited.
 *
 * Debounced on baseUrl/apiKey/apiStyle. A saved provider paints its cached list
 * first and then refreshes live; the stored secret is reused when no key is
 * typed (the main process reads the keychain for `providerId`).
 */
export function useProviderModels(
  active: boolean,
  form: { baseUrl: string; apiKey: string; apiStyle: string },
  editingProvider?: ProviderPublic | null,
): ProviderModelsState {
  const [state, setState] = useState<ProviderModelsState>(IDLE);
  // Only the newest request may commit: a slow reply from an older keystroke
  // must never overwrite a newer result.
  const requestSeq = useRef(0);

  const { baseUrl, apiKey, apiStyle } = form;
  const providerId = editingProvider?.id;

  useEffect(() => {
    if (!active || !canDiscover(baseUrl)) {
      requestSeq.current += 1;
      setState(IDLE);
      return;
    }

    const requestId = ++requestSeq.current;
    setState((prev) => ({ status: "loading", models: prev.models }));

    const run = async () => {
      let cachedModels: ModelInfo[] = [];
      if (providerId) {
        try {
          const cached = await api.listProviderModels({
            providerId,
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
          ...(providerId ? { providerId } : {}),
          baseUrl: baseUrl.trim(),
          ...(apiKey ? { apiKey } : {}),
          apiStyle,
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

    // An existing provider opens with a known-good config — fetch right away.
    const immediate = !!providerId && !apiKey;
    const timer = setTimeout(() => void run(), immediate ? 0 : FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, baseUrl, apiKey, apiStyle, providerId]);

  return state;
}
