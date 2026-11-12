import type {
  Mode,
  ProviderPublic,
  SessionThinkingLevel,
} from "@pi-desktop/shared";
import {
  initialThinkingLevelForBinding,
  initialThinkingLevelForUnmatchedModel,
} from "@pi-desktop/shared";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  composerModelBinding,
  composerModelMatchesQuery,
  composerModelsForProvider,
  sameComposerModelId,
} from "../../../../lib/composer-models";
import {
  providerDisplayName,
  providerSearchText,
} from "../../../../lib/provider-display";
import { sameRecentModel } from "../../../../lib/recent-models";
import { providerThinkingLevels } from "../../../../lib/session-thinking";
import { useAppStore } from "../../../../stores/app-store";
import {
  sessionThinkingMenuLevels,
  thinkingLevelForProvider,
  thinkingProviderForModel,
} from "../model";
import { createLatestCommitQueue } from "../thinking-commit-queue";

/** Rail section that lists the most recently used models. */
export const RECENT_MODEL_SECTION = "recent";
/** Recent rows get their own rail section, so a few more than one screen fits. */
const RECENT_MODEL_LIMIT = 6;

export function providerModelSection(providerId: string): string {
  return `provider:${providerId}`;
}

export type ComposerModelSection =
  | { id: string; kind: "recent"; count: number }
  | { id: string; kind: "provider"; provider: ProviderPublic; label: string; count: number };

type UseComposerModelMenuOptions = {
  mode: Mode;
  activeSessionId: string | null | undefined;
  provider: ProviderPublic | undefined;
  modelId: string | undefined;
  thinkingProvider: ProviderPublic | null | undefined;
  thinkingLevel: SessionThinkingLevel;
  controlsBlocked: boolean;
  configureActiveSession: (configuration: {
    mode: Mode; providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel;
  }) => Promise<void>;
};

export function useComposerModelMenu({
  mode,
  activeSessionId,
  provider,
  modelId,
  thinkingProvider: resolvedThinkingProvider,
  thinkingLevel,
  controlsBlocked,
  configureActiveSession,
}: UseComposerModelMenuOptions) {
  const providers = useAppStore((s) => s.providers);
  const recentModels = useAppStore((s) => s.recentModels);
  const providerModels = useAppStore((s) => s.providerModels);
  const loadProviderModels = useAppStore((s) => s.loadProviderModels);
  const showToast = useAppStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  // null follows the default section; a rail click pins one until close.
  const [section, setSection] = useState<string | null>(null);
  // Direction of the last rail move, so the pane slides in from that side.
  const [sectionStep, setSectionStep] = useState(0);
  const [query, setQuery] = useState("");
  const [modelHighlight, setModelHighlight] = useState(-1);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
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
          );
          return {
            provider: candidate,
            providerDisplayName: providerDisplayName(candidate),
            providerSearchText: providerSearchText(candidate),
            models,
          };
        })
        .filter((group) => group.models.length > 0),
    [providers, providerModels],
  );
  const recentEntries = useMemo(() => {
    const entries = modelGroups.flatMap(group => group.models.map(model => ({ provider: group.provider, model })));
    return (recentModels ?? []).flatMap(recent => {
      const entry = entries.find(entry => sameRecentModel(recent, {
        providerId: entry.provider.id, modelId: entry.model.modelId,
      }));
      return entry ? [entry] : [];
    }).slice(0, RECENT_MODEL_LIMIT);
  }, [modelGroups, recentModels]);
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
                  composerModelBinding(group.provider, model.modelId)?.alias,
                ),
              ),
            }))
            .filter((group) => group.models.length > 0)
        : modelGroups,
    [modelGroups, queryNeedle],
  );
  const searching = queryNeedle.length > 0;
  // While searching, provider counts become match counts so the rail shows
  // where the results live; the recent section has no separate result set.
  const sections = useMemo<ComposerModelSection[]>(() => [
    ...(recentEntries.length > 0
      ? [{ id: RECENT_MODEL_SECTION, kind: "recent" as const, count: recentEntries.length }]
      : []),
    ...modelGroups.map((group) => ({
      id: providerModelSection(group.provider.id),
      kind: "provider" as const,
      provider: group.provider,
      label: group.providerDisplayName,
      count: searching
        ? (filteredModelGroups.find((candidate) => candidate.provider.id === group.provider.id)?.models.length ?? 0)
        : group.models.length,
    })),
  ], [filteredModelGroups, modelGroups, recentEntries.length, searching]);
  // One pane height for every source: the tallest source (or the rail itself)
  // decides it, so switching sources or typing never resizes the menu.
  const paneRows = Math.max(
    sections.length,
    recentEntries.length,
    ...modelGroups.map((group) => group.models.length),
  );
  const selectedProviderSection =
    provider && modelGroups.some((group) => group.provider.id === provider.id)
      ? providerModelSection(provider.id)
      : null;
  const defaultSection =
    recentEntries.length > 0 ? RECENT_MODEL_SECTION : (selectedProviderSection ?? sections[0]?.id ?? null);
  const activeSection =
    section && sections.some((candidate) => candidate.id === section) ? section : defaultSection;
  const visibleRecents = useMemo(
    () => (!searching && activeSection === RECENT_MODEL_SECTION ? recentEntries : []),
    [activeSection, recentEntries, searching],
  );
  const visibleGroups = useMemo(
    () => searching
      ? filteredModelGroups
      : modelGroups.filter((group) => providerModelSection(group.provider.id) === activeSection),
    [activeSection, filteredModelGroups, modelGroups, searching],
  );
  const flatModels = useMemo(
    () =>
      [...visibleRecents, ...visibleGroups.flatMap((group) =>
        group.models.map((model) => ({ provider: group.provider, model })),
      )],
    [visibleGroups, visibleRecents],
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
          sameComposerModelId(entry.model.modelId, modelId ?? ""),
      ),
    [flatModels, provider?.id, modelId],
  );

  useEffect(() => {
    if (!open) return;
    setModelHighlight(queryNeedle ? (flatModels.length ? 0 : -1) : activeFlatIndex);
  }, [activeFlatIndex, flatModels.length, flatModelsKey, open, queryNeedle]);

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
    setSection(null);
    setSectionStep(0);
    setQuery("");
    setModelHighlight(-1);
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
    if (!open || modelHighlight < 0) return;
    modelListRef.current
      ?.querySelector(`[data-model-index="${modelHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [modelHighlight, open]);

  const selectModel = async (candidate: ProviderPublic, nextModelId: string) => {
    thinkingQueueRef.current?.invalidate();
    await thinkingQueueRef.current?.idle();
    // An image-generation designation must not block chat selection: the
    // image binding is independent of the conversation route.
    try {
      const nextModelProvider = thinkingProviderForModel(
        candidate,
        nextModelId,
        providerModels[candidate.id],
      );
      const nextBinding = candidate.models.find((entry) =>
        sameComposerModelId(entry.id, nextModelId),
      );
      const nextModel = providerModels[candidate.id]?.find((entry) =>
        sameComposerModelId(entry.modelId, nextModelId),
      );
      const selectedSameModel =
        activeSessionId &&
        candidate.id === provider?.id &&
        sameComposerModelId(modelId ?? "", nextModelId);
      const nextThinkingLevel = selectedSameModel
        ? thinkingLevelForProvider(nextModelProvider, thinkingLevel)
        : (nextModel?.catalogSource === "models.dev"
          ? initialThinkingLevelForBinding(
              nextBinding,
              nextModelProvider?.supportedThinkingLevels,
            )
          : initialThinkingLevelForUnmatchedModel(
              nextBinding,
              nextModelProvider?.supportedThinkingLevels,
            ));
      await configureActiveSession({
        mode,
        providerId: candidate.id,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      });
      setQuery("");
      setModelHighlight(-1);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  /** Show one rail section. Picking a source ends any search in progress. */
  const selectSection = (id: string) => {
    const from = sections.findIndex((candidate) => candidate.id === activeSection);
    const to = sections.findIndex((candidate) => candidate.id === id);
    // The pane is keyed by section, so an unchanged section never replays.
    setSectionStep(to < from ? -1 : 1);
    setSection(id);
    setQuery("");
    setModelHighlight(-1);
    modelListRef.current?.scrollTo({ top: 0 });
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

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      // A search in progress is the innermost state: Escape clears it first.
      if (query && event.target instanceof HTMLInputElement) {
        setQuery("");
        setModelHighlight(-1);
        return;
      }
      setOpen(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        const entry = flatModels[modelHighlight];
        if (entry) {
          event.preventDefault();
          void selectModel(entry.provider, entry.model.modelId);
        }
      }
      return;
    }
    if (!(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (!flatModels.length) return;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setModelHighlight((current) => {
      const base = current < 0 ? (delta > 0 ? -1 : flatModels.length) : current;
      return (base + delta + flatModels.length) % flatModels.length;
    });
  };

  return {
    open,
    setOpen,
    sections,
    activeSection: searching ? null : activeSection,
    sectionStep,
    selectSection,
    showSectionRail: sections.length > 1,
    paneRows,
    searching,
    query,
    setQuery,
    modelHighlight,
    setModelHighlight,
    modelSearchRef,
    modelListRef,
    modelGroups: visibleGroups,
    recentEntries: visibleRecents,
    flatModels,
    thinkingMenuLevels,
    selectModel,
    commitThinkingLevel,
    onMenuKeyDown,
    controlsBlocked,
  };
}
