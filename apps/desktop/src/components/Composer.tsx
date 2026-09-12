import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  Mode,
  PermissionMode,
} from "@pi-desktop/shared";
import {
  initialThinkingLevelForBinding,
  modelIdsMatch,
  normalizeLargePasteThreshold,
  stripInlineComposerFileReferenceTokens,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { latestTurnContextInspector } from "../lib/latest-turn-context";
import { isActivePlanExecution } from "../lib/plan-mode-state";
import { headAsk, queuedAskCount } from "../lib/pending-asks";
import type { QueuedPrompt } from "../lib/queued-prompts";
import {
  composerModelDisplayName,
  composerModelsForProvider,
} from "../lib/composer-models";
import {
  providerThinkingLevels,
  resolveComposerThinkingProvider,
} from "../lib/session-thinking";
import {
  useComposerAutocomplete,
} from "../hooks/use-composer-autocomplete";
import { ComposerAutocomplete } from "./ComposerAutocomplete";
import { AskToolCard } from "./AskToolCard";
import { PlanApprovalBar } from "./PlanApprovalBar";
import {
  COMPOSER_MAX_VISIBLE_ROWS,
  COMPOSER_MIN_HEIGHT_PX,
  PLACEHOLDER_KEYS,
  cssPixels,
  isPermissionMode,
  isThinkingLevel,
  thinkingLevelForProvider,
  thinkingProviderForModel,
  THINKING_LEVELS,
  type ComposerPrefill,
} from "../features/chat/composer/model";
import {
  createFileReference,
  editorSelectionRange,
  isImageFilePath,
  nextChipToken,
} from "../features/chat/composer/editor";
import { useComposerAttachments } from "../features/chat/composer/hooks/useComposerAttachments";
import { useComposerDraft } from "../features/chat/composer/hooks/useComposerDraft";
import { useComposerSubmit } from "../features/chat/composer/hooks/useComposerSubmit";
import { ComposerInput } from "../features/chat/composer/ComposerInput";
import { useComposerModelMenu } from "../features/chat/composer/hooks/useComposerModelMenu";
import { ComposerToolbar } from "../features/chat/composer/ComposerToolbar";
import { ComposerStatus } from "../features/chat/composer/ComposerStatus";

const EMPTY_QUEUED_PROMPTS: QueuedPrompt[] = [];

export {
  THINKING_LEVELS,
  thinkingLevelForProvider,
  thinkingProviderForModel,
  type ComposerPrefill,
} from "../features/chat/composer/model";

export function Composer({
  variant = "docked",
  prefill,
}: {
  variant?: "home" | "docked";
  prefill?: ComposerPrefill | null;
}) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const steerPrompt = useAppStore((s) => s.steerPrompt);
  const removeQueuedPrompt = useAppStore((s) => s.removeQueuedPrompt);
  const sendQueuedNow = useAppStore((s) => s.sendQueuedNow);
  const abort = useAppStore((s) => s.abort);
  const isRunning = useAppStore((s) => s.isRunning);
  const planningState = useAppStore((s) =>
    s.activeSessionId ? s.planningStates[s.activeSessionId] : undefined,
  );
  const settings = useAppStore((s) => s.settings);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const workspacePath = useAppStore((s) => s.workspace?.path ?? "");
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const liveMessages = useAppStore((s) => s.messages);
  const sessionCompactions = useAppStore((s) =>
    s.activeSessionId ? s.sessionCompactions[s.activeSessionId] : undefined,
  );
  // One inspector in the composer toolbar, always the newest turn with usage.
  const composerContextUsage = useMemo(
    () =>
      latestTurnContextInspector(
        liveMessages,
        providerModels,
        providers,
        sessionCompactions,
      ),
    [liveMessages, providerModels, providers, sessionCompactions],
  );
  const configureActiveSession = useAppStore((s) => s.configureActiveSession);
  const showToast = useAppStore((s) => s.showToast);
  const composerPrefill = useAppStore((s) => s.composerPrefill);
  const clearComposerPrefill = useAppStore((s) => s.clearComposerPrefill);
  const planCheckpoint = useAppStore((s) =>
    s.activeSessionId ? s.planCheckpoints[s.activeSessionId] : undefined,
  );
  const pendingAsk = useAppStore((s) =>
    headAsk(s.pendingAsks, s.activeSessionId),
  );
  const queuedAsks = useAppStore((s) =>
    queuedAskCount(s.pendingAsks, s.activeSessionId),
  );
  const queuedPrompts = useAppStore((s) =>
    s.activeSessionId
      ? s.queuedPrompts[s.activeSessionId] ?? EMPTY_QUEUED_PROMPTS
      : EMPTY_QUEUED_PROMPTS,
  );

  const [permissionOpen, setPermissionOpen] = useState(false);
  const enhancementInvalidateRef = useRef<() => void>(() => {});
  const composerShellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const publishedDockHeightRef = useRef(-1);

  const invalidatePromptEnhancement = () => {
    enhancementInvalidateRef.current();
  };

  const draft = useComposerDraft({
    variant,
    activeSessionId,
    workspacePath,
    sessions,
    composerPrefill,
    clearComposerPrefill,
    prefill,
    t,
    invalidatePromptEnhancement,
    inputBlocked: planCheckpoint?.status === "pending",
  });
  const {
    ref,
    draftKey,
    referenceSessionId,
    value,
    setValue,
    valueRef,
    cursor,
    setCursor,
    composing,
    setComposing,
    inputFocused,
    setInputFocused,
    placeholderIndex,
    activeFileReferences,
    fileReferencesRef,
    applyEditorDraft,
    snapshotReferences,
    draftSnapshot,
    clearDraftForKey,
    restoreDraftForKey,
    persistDraft,
    commitEditorDom,
    insertNewlineInEditor,
    handleInput,
  } = draft;

  const approvalPending = planCheckpoint?.status === "pending";
  const largePasteThreshold = normalizeLargePasteThreshold(
    settings?.largePasteThreshold,
  );
  const attachments = useComposerAttachments({
    inputBlocked: approvalPending,
    activeSessionId,
    draftKey,
    largePasteThreshold,
    t,
    draft: {
      ref,
      valueRef,
      fileReferencesRef: draft.fileReferencesRef,
      applyEditorDraft,
      snapshotReferences,
      commitEditorDom,
    },
  });
  const {
    pasting,
    dropTargetActive,
    droppedDirectories,
    pickAndAttach,
    pasteClipboardFiles,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    openDroppedFolderAsProject,
    insertDroppedDirectoryPaths,
    dismissDroppedDirectories,
  } = attachments;
  const executionActive = isActivePlanExecution(planCheckpoint);
  const runActive = isRunning || executionActive;
  const inputBlocked = approvalPending || pasting;
  const controlsBlocked = approvalPending;
  const sendBlocked = approvalPending || pasting;
  const enhancementDraft = stripInlineComposerFileReferenceTokens(
    value,
    activeFileReferences,
  );
  const placeholderKeys = PLACEHOLDER_KEYS[variant];
  const placeholderKey =
    placeholderKeys[placeholderIndex % placeholderKeys.length] ?? placeholderKeys[0];
  const placeholderText = t(placeholderKey);

  const textareaMetricsRef = useRef<{ lineHeight: number; verticalChrome: number } | null>(null);
  const appliedHeightRef = useRef<number | null>(null);
  const appliedOverflowRef = useRef<string | null>(null);
  useEffect(() => {
    textareaMetricsRef.current = null;
    appliedHeightRef.current = null;
    appliedOverflowRef.current = null;
  }, [variant]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let metrics = textareaMetricsRef.current;
    if (!metrics) {
      const style = window.getComputedStyle(el);
      metrics = {
        lineHeight: cssPixels(style.lineHeight) || COMPOSER_MIN_HEIGHT_PX,
        verticalChrome:
          cssPixels(style.paddingTop) +
          cssPixels(style.paddingBottom) +
          cssPixels(style.borderTopWidth) +
          cssPixels(style.borderBottomWidth),
      };
      textareaMetricsRef.current = metrics;
    }
    const maxHeight = Math.ceil(
      metrics.lineHeight * COMPOSER_MAX_VISIBLE_ROWS + metrics.verticalChrome,
    );
    const applied =
      appliedHeightRef.current !== null &&
      el.style.height === `${appliedHeightRef.current}px`
        ? appliedHeightRef.current
        : null;
    let content = applied === null ? -1 : el.scrollHeight;
    if (
      applied === null ||
      (content <= el.clientHeight && applied > COMPOSER_MIN_HEIGHT_PX)
    ) {
      el.style.height = "auto";
      content = el.scrollHeight;
    }
    const next = Math.max(COMPOSER_MIN_HEIGHT_PX, Math.min(content, maxHeight));
    const overflowY = content > maxHeight ? "auto" : "hidden";
    if (appliedHeightRef.current !== next || el.style.height !== `${next}px`) {
      el.style.height = `${next}px`;
      appliedHeightRef.current = next;
    }
    if (appliedOverflowRef.current !== overflowY) {
      el.style.overflowY = overflowY;
      appliedOverflowRef.current = overflowY;
    }
  }, [value]);


  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const draftConfiguration = useAppStore((s) => s.draftConfiguration);
  const mode: Mode = activeSession
    ? activeSession.mode
    : (draftConfiguration?.mode ?? settings?.defaultMode ?? "agent");
  const planningLive =
    isRunning &&
    planningState === "planning" &&
    (mode === "plan" || mode === "goal");
  // Permission mode (D115/D132): inherited sessions still resolve through the
  // global setting, but the composer presents only the effective mode.
  const globalPermissionMode: PermissionMode =
    settings?.defaultPermissionMode ?? "ask";
  const sessionPermissionMode: PermissionMode = activeSession
    ? isPermissionMode(activeSession.permissionMode)
      ? activeSession.permissionMode
      : "inherit"
    : isPermissionMode(draftConfiguration?.permissionMode)
      ? draftConfiguration.permissionMode
      : "inherit";
  const effectivePermissionMode: Exclude<PermissionMode, "inherit"> =
    sessionPermissionMode === "inherit"
      ? (globalPermissionMode as Exclude<PermissionMode, "inherit">)
      : sessionPermissionMode;
  const composerPermissionMode: Exclude<PermissionMode, "inherit"> =
    mode === "goal" ? "auto" : effectivePermissionMode;
  const provider = providers.find(
    (candidate) =>
      candidate.id ===
      (activeSession?.providerId ??
        (!activeSession ? draftConfiguration?.providerId : undefined) ??
        settings?.defaultProviderId),
  );
  const modelId =
    activeSession?.modelId ??
    (!activeSession ? draftConfiguration?.modelId : undefined) ??
    settings?.defaultModelId ??
    provider?.defaultModelId;
  const selectedModelCatalog = provider ? providerModels[provider.id] : undefined;
  const catalogThinkingProvider = thinkingProviderForModel(
    provider,
    modelId,
    selectedModelCatalog,
  );
  const thinkingProvider = resolveComposerThinkingProvider({
    provider,
    modelId,
    activeSession,
    catalogThinkingProvider,
  });
  const selectedBinding = provider?.models.find((candidate) =>
    modelIdsMatch(candidate.id, modelId ?? ""),
  );
  // A draft without a session starts at the selected model's stored default
  // thinking level, clamped onto that binding's enabled ladder.
  const draftThinkingLevel = initialThinkingLevelForBinding(
    selectedBinding,
    thinkingProvider?.supportedThinkingLevels,
  );
  const sessionThinkingLevel =
    activeSession?.thinkingLevel ??
    (!activeSession ? draftConfiguration?.thinkingLevel : undefined) ??
    draftThinkingLevel;
  const configuredThinkingLevel = isThinkingLevel(sessionThinkingLevel)
    ? sessionThinkingLevel
    : "off";
  const availableThinkingLevels = providerThinkingLevels(thinkingProvider);
  const thinkingLevel = thinkingLevelForProvider(
    thinkingProvider,
    configuredThinkingLevel,
  );
  const thinkingLabel = thinkingLevel;
  const selectedModel = provider?.id
    ? composerModelsForProvider(provider, providerModels[provider.id]).find(
        (model) => modelIdsMatch(model.modelId, modelId ?? ""),
      )
    : undefined;
  const modelLabel = provider && modelId
    ? composerModelDisplayName(provider, modelId, selectedModel?.displayName)
    : selectedModel?.displayName || modelId || t("chat.model");
  const modelMenu = useComposerModelMenu({
    mode,
    activeSessionId,
    provider,
    modelId,
    thinkingProvider,
    thinkingLevel,
    controlsBlocked,
  });
  const modelReady =
    !!provider &&
    provider.enabled &&
    !!modelId &&
    (provider.hasSecret || provider.authKind === "none");
  const enterToSend = settings?.enterToSend ?? true;
  // Chips occupy sentinel characters, which `trim()` preserves — text and
  // attachments share one content check.
  const hasDraftContent = Boolean(value.trim());

  useEffect(() => {
    if (!controlsBlocked) return;
    setPermissionOpen(false);
  }, [controlsBlocked]);

  const submitController = useComposerSubmit({
    value,
    draftKey,
    activeSessionId,
    providerId: provider?.id,
    modelId,
    thinkingLevel,
    modelReady,
    sendBlocked,
    pasting,
    activeFileReferences,
    t,
    sendPrompt,
    steerPrompt,
    showToast,
    draft: {
      ref,
      draftSnapshot,
      clearDraftForKey,
      restoreDraftForKey,
      setValue,
      setCursor,
    },
  });
  enhancementInvalidateRef.current = submitController.invalidatePromptEnhancement;
  const {
    enhancingPrompt,
    enhancementUndoText,
    enhancementError,
    clearEnhancementError,
    enhancePrompt,
    undoPromptEnhancement,
    submit,
  } = submitController;


  const composerAc = useComposerAutocomplete({
    value,
    cursor,
    composing,
    enabled: !inputBlocked,
  });

  const acceptCompletion = (index: number) => {
    const result = composerAc.accept(index);
    if (!result) return;
    invalidatePromptEnhancement();
    // File accept strips the @ token (empty insert) and used to store a
    // token-less chip above the textarea. Inline chips only paint when a
    // sentinel is in the draft, so Enter looked like the reference vanished.
    const acceptedFileReference = result.fileReference;
    if (!acceptedFileReference) {
      applyEditorDraft(result.value, fileReferencesRef.current, result.cursor);
      return;
    }
    const token = nextChipToken();
    const nextText =
      result.value.slice(0, result.cursor) + token + result.value.slice(result.cursor);
    applyEditorDraft(
      nextText,
      [
        ...fileReferencesRef.current,
        createFileReference(
          acceptedFileReference.path,
          acceptedFileReference.name,
          referenceSessionId,
          {
            kind: isImageFilePath(acceptedFileReference.path) ? "image" : "file",
            token,
          },
        ),
      ],
      result.cursor + token.length,
    );
  };

  // Keep the transcript's bottom reserve in sync with the composer's real
  // height (it grows with multi-line input) so the last message sits just
  // above the box instead of far below it.
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    // Setting a custom property on documentElement invalidates style for the
    // whole document, so an unchanged dock height must not be republished.
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h === publishedDockHeightRef.current) return;
      publishedDockHeightRef.current = h;
      document.documentElement.style.setProperty(
        "--composer-dock-height",
        `${h}px`,
      );
    };
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [variant]);

  return (
    <div
      ref={dockRef}
      className={`composer-dock composer-dock-${variant}`}
    >
      <div className="composer-stack">
        {planCheckpoint?.status === "pending" ? (
          <PlanApprovalBar proposal={planCheckpoint} />
        ) : null}
        {pendingAsk ? (
          <AskToolCard request={pendingAsk} queued={queuedAsks} />
        ) : null}
        <ComposerStatus
          t={t}
          queuedPrompts={queuedPrompts}
          removeQueuedPrompt={removeQueuedPrompt}
          sendQueuedNow={sendQueuedNow}
          approvalPending={approvalPending}
          runActive={runActive}
          enhancementError={enhancementError}
          clearEnhancementError={clearEnhancementError}
          droppedDirectories={droppedDirectories}
          openDroppedFolderAsProject={openDroppedFolderAsProject}
          insertDroppedDirectoryPaths={insertDroppedDirectoryPaths}
          dismissDroppedDirectories={dismissDroppedDirectories}
        />
        <div
          ref={composerShellRef}
          className={`composer-shell${inputBlocked ? " is-gated" : ""}${
            dropTargetActive ? " is-drop-target" : ""
          }`}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          {inputFocused ? (
            <ComposerAutocomplete
              anchorRef={composerShellRef}
              ac={composerAc}
              onAccept={acceptCompletion}
            />
          ) : null}
          <ComposerInput
            inputRef={ref}
            value={value}
            placeholderText={placeholderText}
            placeholderKey={`${variant}-${placeholderIndex}-${placeholderText}`}
            inputBlocked={inputBlocked}
            pasting={pasting}
            enterToSend={enterToSend}
            runActive={runActive}
            composerAc={composerAc}
            onPaste={pasteClipboardFiles}
            onAcceptCompletion={acceptCompletion}
            onSubmit={(steering) => void submit(steering)}
            onInsertNewline={insertNewlineInEditor}
            onInput={handleInput}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false);
              draft.updateCursor(editorSelectionRange(event.currentTarget).start);
            }}
            onFocus={() => setInputFocused(true)}
            onBlur={() => {
              setInputFocused(false);
              persistDraft();
            }}
          />
          <ComposerToolbar
            t={t}
            mode={mode}
            planningLive={planningLive}
            providerId={provider?.id}
            modelId={modelId}
            thinkingLevel={thinkingLevel}
            composerPermissionMode={composerPermissionMode}
            permissionOpen={permissionOpen}
            setPermissionOpen={setPermissionOpen}
            controlsBlocked={controlsBlocked}
            pasting={pasting}
            pickAndAttach={pickAndAttach}
            configureActiveSession={configureActiveSession}
            showToast={showToast}
            modelMenu={modelMenu}
            modelLabel={modelLabel}
            thinkingLabel={thinkingLabel}
            contextUsage={composerContextUsage ?? null}
            enhancementDraft={enhancementDraft}
            value={value}
            modelReady={modelReady}
            sendBlocked={sendBlocked}
            enhancingPrompt={enhancingPrompt}
            enhancementUndoText={enhancementUndoText}
            enhancePrompt={enhancePrompt}
            undoPromptEnhancement={undoPromptEnhancement}
            clearEnhancementError={clearEnhancementError}
            runActive={runActive}
            hasDraftContent={hasDraftContent}
            abort={abort}
            submit={submit}
          />
        </div>
      </div>
    </div>
  );
}
