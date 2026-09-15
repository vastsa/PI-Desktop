import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  Mode,
  ProviderPublic,
  ThinkingLevel,
  ThinkingLevelMode,
} from "@pi-desktop/shared";
import {
  AUTO_THINKING_BASELINE,
  initialThinkingLevelForBinding,
  modelIdsMatch,
} from "@pi-desktop/shared";
import { useAppStore } from "../../../../stores/app-store";
import {
  composerModelMatchesQuery,
  composerModelsForProvider,
  composerProviderDisplayName,
  composerProviderSearchText,
} from "../../../../lib/composer-models";
import { providerThinkingLevels } from "../../../../lib/session-thinking";
import {
  thinkingLevelForProvider,
  thinkingProviderForModel,
  type ComposerMenuView,
  type ComposerThinkingMenuLevel,
} from "../model";

type UseComposerModelMenuOptions = {
  mode: Mode;
  activeSessionId: string | null | undefined;
  provider: ProviderPublic | undefined;
  modelId: string | undefined;
  thinkingProvider: ProviderPublic | null | undefined;
  thinkingLevel: ThinkingLevel;
  thinkingLevelMode: ThinkingLevelMode;
  controlsBlocked: boolean;
};

export function useComposerModelMenu({
  mode,
  activeSessionId,
  provider,
  modelId,
  thinkingProvider: resolvedThinkingProvider,
  thinkingLevel,
  thinkingLevelMode,
  controlsBlocked,
}: UseComposerModelMenuOptions) {
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const loadProviderModels = useAppStore((s) => s.loadProviderModels);
  const configureActiveSession = useAppStore((s) => s.configureActiveSession);
  const showToast = useAppStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ComposerMenuView>("root");
  const [query, setQuery] = useState("");
  const [modelHighlight, setModelHighlight] = useState(-1);
  const [thinkingHighlight, setThinkingHighlight] = useState(-1);
  const rootMenuRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const thinkingListRef = useRef<HTMLDivElement>(null);

  const thinkingProvider =
    resolvedThinkingProvider ??
    thinkingProviderForModel(
      provider,
      modelId,
      provider ? providerModels[provider.id] : undefined,
    );
  const availableThinkingLevels = providerThinkingLevels(thinkingProvider);
  // ADR 0257: reasoning models get the virtual `auto` entry ahead of the
  // canonical ladder; non-reasoning models keep the `off`-only menu.
  const thinkingMenuLevels: ComposerThinkingMenuLevel[] =
    availableThinkingLevels.length
      ? ["auto", ...availableThinkingLevels]
      : ["off"];
  const selectedThinkingMenuLevel: ComposerThinkingMenuLevel =
    thinkingLevelMode === "auto" && availableThinkingLevels.length > 0
      ? "auto"
      : thinkingLevel;
  const modelGroups = useMemo(
    () =>
      providers
        .filter(
          (candidate) =>
            candidate.enabled &&
            (candidate.hasSecret || candidate.authKind === "none"),
        )
        .map((candidate) => {
          const models = composerModelsForProvider(
            candidate,
            providerModels[candidate.id],
          );
          return {
            provider: candidate,
            providerDisplayName: composerProviderDisplayName(candidate),
            providerSearchText: composerProviderSearchText(candidate),
            models,
          };
        })
        .filter((group) => group.models.length > 0),
    [providers, providerModels],
  );
  const queryNeedle = query.trim().toLowerCase();
  const filteredModelGroups = useMemo(
    () =>
      queryNeedle
        ? modelGroups
            .map((group) => ({
              ...group,
              models: group.models.filter((model) =>
                composerModelMatchesQuery(
                  model,
                  group.providerSearchText,
                  queryNeedle,
                ),
              ),
            }))
            .filter((group) => group.models.length > 0)
        : modelGroups,
    [modelGroups, queryNeedle],
  );
  const flatModels = useMemo(
    () =>
      filteredModelGroups.flatMap((group) =>
        group.models.map((model) => ({ provider: group.provider, model })),
      ),
    [filteredModelGroups],
  );
  const flatModelsKey = useMemo(
    () => flatModels.map((entry) => `${entry.provider.id}:${entry.model.modelId}`).join("|"),
    [flatModels],
  );
  const activeFlatIndex = useMemo(
    () =>
      flatModels.findIndex(
        (entry) =>
          entry.provider.id === provider?.id &&
          entry.model.modelId === modelId,
      ),
    [flatModels, provider?.id, modelId],
  );
  useEffect(() => {
    if (!open || view !== "model") return;
    setModelHighlight(queryNeedle ? (flatModels.length ? 0 : -1) : activeFlatIndex);
  }, [activeFlatIndex, flatModels.length, flatModelsKey, open, queryNeedle, view]);
  useEffect(() => {
    if (!open || view !== "thinking") return;
    setThinkingHighlight(
      thinkingMenuLevels.indexOf(selectedThinkingMenuLevel),
    );
  }, [open, selectedThinkingMenuLevel, thinkingMenuLevels, view]);

  useEffect(() => {
    if (!open) return;
    for (const candidate of providers) {
      if (candidate.enabled && (candidate.hasSecret || candidate.authKind === "none")) {
        void loadProviderModels(candidate.id);
      }
    }
  }, [loadProviderModels, open, providers]);

  useEffect(() => {
    if (open) return;
    setView("root");
    setQuery("");
    setModelHighlight(-1);
    setThinkingHighlight(-1);
  }, [open]);

  useEffect(() => {
    if (controlsBlocked) setOpen(false);
  }, [controlsBlocked]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      if (view === "root") rootMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      if (view === "model") modelSearchRef.current?.focus();
      if (view === "thinking") thinkingListRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      if (view === "model" && modelHighlight >= 0) {
        modelListRef.current
          ?.querySelector(`[data-model-index="${modelHighlight}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
      if (view === "thinking" && thinkingHighlight >= 0) {
        thinkingListRef.current
          ?.querySelector(`[data-thinking-index="${thinkingHighlight}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    });
  }, [open, view]);

  useEffect(() => {
    if (!open || view !== "model" || modelHighlight < 0) return;
    modelListRef.current
      ?.querySelector(`[data-model-index="${modelHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [modelHighlight, open, view]);

  useEffect(() => {
    if (!open || view !== "thinking" || thinkingHighlight < 0) return;
    thinkingListRef.current
      ?.querySelector(`[data-thinking-index="${thinkingHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, thinkingHighlight, view]);

  const showView = (nextView: ComposerMenuView) => {
    setView(nextView);
    setModelHighlight(-1);
    setThinkingHighlight(-1);
    if (nextView !== "model") setQuery("");
  };

  const selectModel = async (candidate: ProviderPublic, nextModelId: string) => {
    try {
      const nextModelProvider = thinkingProviderForModel(
        candidate,
        nextModelId,
        providerModels[candidate.id],
      );
      const nextBinding = candidate.models.find((entry) =>
        modelIdsMatch(entry.id, nextModelId),
      );
      const nextThinkingLevel = activeSessionId
        ? thinkingLevelForProvider(nextModelProvider, thinkingLevel)
        : initialThinkingLevelForBinding(
            nextBinding,
            nextModelProvider?.supportedThinkingLevels,
          );
      const nextThinkingLevelMode: ThinkingLevelMode =
        thinkingLevelMode === "auto" &&
        providerThinkingLevels(nextModelProvider).length > 0
          ? "auto"
          : "manual";
      await configureActiveSession({
        mode,
        providerId: candidate.id,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
        // Non-reasoning models cannot use the session-layer auto mode.
        // Reasoning-capable model switches preserve it (ADR 0257).
        thinkingLevelMode: nextThinkingLevelMode,
      });
      setQuery("");
      setView("root");
      setModelHighlight(-1);
      setThinkingHighlight(-1);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const selectThinkingLevel = async (level: ComposerThinkingMenuLevel) => {
    try {
      await configureActiveSession({
        mode,
        providerId: provider?.id,
        modelId,
        thinkingLevel: level === "auto" ? AUTO_THINKING_BASELINE : level,
        thinkingLevelMode: level === "auto" ? "auto" : "manual",
      });
      setView("root");
      setModelHighlight(-1);
      setThinkingHighlight(-1);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowLeft" && view !== "root") {
      event.preventDefault();
      showView("root");
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      if (event.key === "Enter" && view === "model" && event.target instanceof HTMLInputElement) {
        const entry = flatModels[modelHighlight];
        if (entry) {
          event.preventDefault();
          void selectModel(entry.provider, entry.model.modelId);
        }
      }
      if (event.key === "Enter" && view === "thinking") {
        const level = thinkingMenuLevels[thinkingHighlight] ?? thinkingMenuLevels[0];
        if (level) {
          event.preventDefault();
          void selectThinkingLevel(level);
        }
      }
      return;
    }
    if (view === "root") return;
    event.preventDefault();
    if (view === "model") {
      if (!flatModels.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setModelHighlight((current) => {
        const base = current < 0 ? (delta > 0 ? -1 : flatModels.length) : current;
        return (base + delta + flatModels.length) % flatModels.length;
      });
      return;
    }
    if (!thinkingMenuLevels.length) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setThinkingHighlight((current) => {
      const base = current < 0 ? (delta > 0 ? -1 : thinkingMenuLevels.length) : current;
      return (base + delta + thinkingMenuLevels.length) % thinkingMenuLevels.length;
    });
  };

  return {
    open,
    setOpen,
    view,
    query,
    setQuery,
    modelHighlight,
    setModelHighlight,
    thinkingHighlight,
    setThinkingHighlight,
    rootMenuRef,
    modelSearchRef,
    modelListRef,
    thinkingListRef,
    modelGroups: filteredModelGroups,
    flatModels,
    thinkingMenuLevels,
    selectedThinkingMenuLevel,
    showView,
    selectModel,
    selectThinkingLevel,
    onMenuKeyDown,
    controlsBlocked,
  };
}
