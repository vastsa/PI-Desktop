import { useEffect, useRef, useState } from "react";
import type { ModelInfo, ProviderPublic } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type { ApiStyle } from "./provider-form";

export type ProviderModelsState =
  | { status: "idle" }
  | { status: "loading"; models: ModelInfo[] }
  | { status: "ready"; models: ModelInfo[] }
  | { status: "error"; models: ModelInfo[] };

const FETCH_DEBOUNCE_MS = 600;

function canDiscover(
  baseUrl: string,
): boolean {
  try {
    new URL(baseUrl.trim());
  } catch {
    return false;
  }
  // Discovery is also useful for local/no-auth gateways. A provider can
  // still return an auth error and leave the custom-model path available.
  return true;
}

/**
 * Auto-discovers the provider's model list while the dialog form is edited.
 * Debounced on baseUrl/apiKey/apiStyle; a stored secret is used when no key
 * is typed (the main process falls back to the keychain for providerId).
 */
export function useProviderModels(
  open: boolean,
  form: { baseUrl: string; apiKey: string; apiStyle: ApiStyle },
  editingProvider: ProviderPublic | null,
): ProviderModelsState {
  const [state, setState] = useState<ProviderModelsState>({ status: "idle" });
  // Only the latest in-flight request may commit its result.
  const requestSeq = useRef(0);

  const { baseUrl, apiKey, apiStyle } = form;

  useEffect(() => {
    if (!open) {
      requestSeq.current += 1;
      setState({ status: "idle" });
      return;
    }
    if (!canDiscover(baseUrl)) {
      requestSeq.current += 1;
      setState({ status: "idle" });
      return;
    }

    const requestId = ++requestSeq.current;
    setState((prev) => ({
      status: "loading",
      models: "models" in prev ? prev.models : [],
    }));

    const run = async () => {
      let cachedModels: ModelInfo[] = [];
      if (editingProvider) {
        try {
          const cached = await api.listProviderModels({
            providerId: editingProvider.id,
            source: "cache",
          });
          if (requestSeq.current !== requestId) return;
          cachedModels = cached.models;
          if (cachedModels.length > 0) {
            setState({ status: "loading", models: cachedModels });
          }
        } catch {
          // Live discovery remains available when the local cache read fails.
        }
      }

      try {
        const result = await api.listProviderModels({
          providerId: editingProvider?.id,
          baseUrl: baseUrl.trim(),
          apiKey: apiKey || undefined,
          apiStyle,
        });
        if (requestSeq.current !== requestId) return;
        if (result.models.length > 0) {
          // A local pi-ai fallback is still a usable model list; only an empty
          // result should surface the unavailable hint while retaining cache.
          setState({ status: "ready", models: result.models });
        } else {
          setState({ status: "error", models: cachedModels });
        }
      } catch {
        if (requestSeq.current !== requestId) return;
        setState({ status: "error", models: cachedModels });
      }
    };

    // An existing provider opens with a known-good config — fetch right away.
    const immediate = !!editingProvider && !apiKey;
    const timer = setTimeout(() => void run(), immediate ? 0 : FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, baseUrl, apiKey, apiStyle, editingProvider]);

  return state;
}
