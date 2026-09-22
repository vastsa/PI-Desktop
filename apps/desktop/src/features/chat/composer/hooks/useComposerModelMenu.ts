import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  Mode,
  ProviderPublic,
  SessionThinkingLevel,
} from "@pi-desktop/shared";
import {
  initialThinkingLevelForBinding,
  imageGenerationBindings,
  isImageGenerationModel,
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
  sessionThinkingMenuLevels,
  thinkingLevelForProvider,
  thinkingProviderForModel,
  type ComposerMenuView,
} from "../model";
import { createLatestCommitQueue } from "../thinking-commit-queue";

type UseComposerModelMenuOptions = {
  mode: Mode;
  activeSessionId: string | null | undefined;
  provider: ProviderPublic | undefined;
  modelId: string | undefined;
  thinkingProvider: ProviderPublic | null | undefined;
  thinkingLevel: SessionThinkingLevel;
  controlsBlocked: boolean;
};

export function useComposerModelMenu({
  mode,
  activeSessionId,
  provider,
  modelId,
  thinkingProvider: resolvedThinkingProvider,
  thinkingLevel,
  controlsBlocked,
}: UseComposerModelMenuOptions) {
  const providers = useAppStore((s) => s.providers);
  const imageGeneration = useAppStore((s) => s.settings?.imageGeneration);
  const imageGenerationModels = useAppStore((s) => s.settings?.imageGenerationModels);
  const imageGenerationCandidates = useMemo(
    () => imageGenerationBindings(imageGenerationModels, imageGeneration),
    [imageGenerationModels, imageGeneration],
  );
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
  const thinkingConfigRef = useRef({
    mode,
    providerId: provider?.id,
    modelId,
    configureActiveSession,
    showToast,
  });
  thinkingConfigRef.current = {
    mode,
    providerId: provider?.id,
    modelId,
    configureActiveSession,
    showToast,
  };
  const thinkingQueueRef = useRef<ReturnType<typeof createLatestCommitQueue<SessionThinkingLevel>> | null>(
    null,
  );
  if (!thinkingQueueRef.current) {
    thinkingQueueRef.current = createLatestCommitQueue<SessionThinkingLevel>({
      send: async (level) => {
        const current = thinkingConfigRef.current;
        await current.configureActiveSession({
          mode: current.mode,
          providerId: current.providerId,
          modelId: current.modelId,
          thinkingLevel: level,
        });
      },
      onError: (error) => {
        const current = thinkingConfigRef.current;
        current.showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      },
    });
  }

  const thinkingProvider =
    resolvedThinkingProvider ??
    thinkingProviderForModel(
      provider,
      modelId,
      provider ? providerModels[provider.id] : undefined,
    );
  const availableThinkingLevels = providerThinkingLevels(thinkingProvider);
  const thinkingMenuLevels = sessionThinkingMenuLevels(availableThinkingLevels);
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
            imageGenerationCandidates,
          );
          return {
            provider: candidate,
            providerDisplayName: composerProviderDisplayName(candidate),
            providerSearchText: composerProviderSearchText(candidate),
            models,
          };
        })
        .filter((group) => group.models.length > 0),
    [providers, providerModels, imageGenerationCandidates],
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
      thinkingLevel ? thinkingMenuLevels.indexOf(thinkingLevel) : -1,
    );
  }, [open, thinkingLevel, thinkingMenuLevels, view]);

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
    thinkingQueueRef.current?.invalidate();
  }, [activeSessionId, provider?.id, modelId]);

  useEffect(() => {
    if (!controlsBlocked) return;
    setOpen(false);
    thinkingQueueRef.current?.invalidate();
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
    thinkingQueueRef.current?.invalidate();
    await thinkingQueueRef.current?.idle();
    if (isImageGenerationModel(
      imageGenerationBindings(
        useAppStore.getState().settings?.imageGenerationModels,
        useAppStore.getState().settings?.imageGeneration,
      ),
      candidate.id,
      nextModelId,
    )) return;
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
      await configureActiveSession({
        mode,
        providerId: candidate.id,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
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

  /**
   * Commit a reasoning level without leaving the menu surface. Latest-wins:
   * a drag that crosses several stops only persists the last pending level
   * after the in-flight write settles. Returns false when the configuration
   * is rejected or invalidated by a session/model change.
   */
  const commitThinkingLevel = (level: SessionThinkingLevel) => {
    const queue = thinkingQueueRef.current;
    if (!queue) return Promise.resolve(false);
    return queue.commit(level);
  };

  const selectThinkingLevel = async (level: SessionThinkingLevel) => {
    if (!(await commitThinkingLevel(level))) return;
    setView("root");
    setModelHighlight(-1);
    setThinkingHighlight(-1);
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
    showView,
    selectModel,
    commitThinkingLevel,
    selectThinkingLevel,
    onMenuKeyDown,
    controlsBlocked,
  };
}
