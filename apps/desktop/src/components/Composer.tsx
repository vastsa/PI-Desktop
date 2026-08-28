import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  ModelInfo,
  Mode,
  PermissionMode,
  ProviderPublic,
  ThinkingLevel,
} from "@pi-desktop/shared";
import {
  fileReferenceLabel,
  highestSupportedThinkingLevel,
  normalizeLargePasteThreshold,
  PERMISSION_MODES,
  serializeComposerFileReferences,
  serializeInlineComposerFileReferences,
} from "@pi-desktop/shared";
import { materializeDraftSession, useAppStore } from "../stores/app-store";
import type { ComposerDraftSnapshot } from "../lib/composer-smart-stop";
import { api } from "../lib/api";
import { isActivePlanExecution } from "../lib/plan-mode-state";
import { headAsk, queuedAskCount } from "../lib/pending-asks";
import type { QueuedPrompt } from "../lib/queued-prompts";
import { runPaletteCommand } from "../lib/commands";
import { composerModelsForProvider } from "../lib/composer-models";
import {
  resolveComposerCommand,
  useComposerAutocomplete,
} from "../lib/use-composer-autocomplete";
import { ComposerAutocomplete } from "./ComposerAutocomplete";
import { AskToolCard } from "./AskToolCard";
import { PlanApprovalBar } from "./PlanApprovalBar";
import {
  IconArrowUp,
  IconUndo2,
  IconShield,
  IconStop,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCheck,
  IconBot,
  IconSearch,
  IconListChecks,
  IconSparkles,
  IconTarget,
  IconFileText,
  IconImage,
  IconX,
} from "./icons";

const COMPOSER_MIN_HEIGHT_PX = 28;
const COMPOSER_MAX_VISIBLE_ROWS = 7;
const PLACEHOLDER_CAROUSEL_INTERVAL_MS = 4_000;
let composerFileReferenceSequence = 0;
const EMPTY_QUEUED_PROMPTS: QueuedPrompt[] = [];

type ComposerFileReference = {
  id: string;
  sessionId: string;
  path: string;
  name: string;
  kind: "image" | "file";
  mimeType?: string;
  token?: string;
};

function isImageFilePath(path: string): boolean {
  return /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(path);
}

function createFileReference(
  path: string,
  preferredName?: string,
  sessionId = "",
  metadata?: {
    kind?: "image" | "file";
    mimeType?: string;
    token?: string;
  },
): ComposerFileReference {
  composerFileReferenceSequence += 1;
  return {
    id: `composer-file-${composerFileReferenceSequence}`,
    sessionId,
    path,
    name: fileReferenceLabel(path, preferredName),
    kind: metadata?.kind ?? (isImageFilePath(path) ? "image" : "file"),
    ...(metadata?.mimeType ? { mimeType: metadata.mimeType } : {}),
    ...(metadata?.token ? { token: metadata.token } : {}),
  };
}

/**
 * The composer-left chip is the only mode control, so one click steps through
 * every mode in a fixed order: execute freely, plan first, then goal contract.
 */
const MODE_CYCLE: readonly Mode[] = ["agent", "plan", "goal"];

function nextMode(mode: Mode): Mode {
  const index = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? "agent";
}

const MODE_LABEL_KEYS: Record<Mode, string> = {
  agent: "settings.modeAgent",
  plan: "settings.modePlan",
  goal: "settings.modeGoal",
};

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === "plan") return <IconListChecks size={14} />;
  if (mode === "goal") return <IconTarget size={14} />;
  return <IconShield size={14} />;
}

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (files.length === 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/**
 * Keep the display order in sync with the runtime's extended thinking
 * levels. Providers decide which of these entries are actually rendered.
 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

const THINKING_LEVEL_I18N_KEYS: Record<ThinkingLevel, string> = {
  off: "chat.effortOff",
  minimal: "chat.effortMinimal",
  low: "chat.effortLow",
  medium: "chat.effortMid",
  high: "chat.effortHigh",
  xhigh: "chat.effortXhigh",
  max: "chat.effortMax",
};

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    PERMISSION_MODES.includes(value as PermissionMode)
  );
}

const PERMISSION_MODE_I18N_KEYS: Record<PermissionMode, string> = {
  inherit: "chat.permissionInherit",
  ask: "chat.permissionAsk",
  "accept-edits": "chat.permissionAcceptEdits",
  auto: "chat.permissionAuto",
};

function providerThinkingLevels(provider?: ProviderPublic | null): ThinkingLevel[] {
  if (!provider?.supportsReasoning) return [];
  const declared = new Set(
    Array.isArray(provider.supportedThinkingLevels)
      ? provider.supportedThinkingLevels
      : [],
  );
  return THINKING_LEVELS.filter((level) => declared.has(level));
}

/**
 * Preserve the current level when changing providers, but never carry a
 * reasoning level into a provider that cannot accept it.
 */
export function thinkingLevelForProvider(
  provider: ProviderPublic | null | undefined,
  current: ThinkingLevel,
): ThinkingLevel {
  const available = providerThinkingLevels(provider);
  if (!provider?.supportsReasoning) return "off";
  if (available.includes(current)) return current;
  const requestedIndex = THINKING_LEVELS.indexOf(current);
  for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (available.includes(candidate)) return candidate;
  }
  return "off";
}

/**
 * Project the selected catalog model onto a provider for draft sessions.
 *
 * Persisted sessions receive these exact capabilities from Electron main.
 * Before the first message creates a session, the provider row only describes
 * its default model, so use the selected catalog record when one is available.
 */
export function thinkingProviderForModel(
  provider: ProviderPublic | null | undefined,
  modelId: string | undefined,
  modelCatalog: readonly ModelInfo[] | undefined,
): ProviderPublic | null | undefined {
  if (!provider || !modelId) return provider;
  const model = modelCatalog?.find((candidate) => candidate.modelId === modelId);
  if (!model) return provider;

  const supportsReasoning = model.capabilities.includes("reasoning");
  return {
    ...provider,
    supportsReasoning,
    supportedThinkingLevels: supportsReasoning
      ? (model.supportedThinkingLevels ?? provider.supportedThinkingLevels)
      : ["off"],
  };
}

function cssPixels(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type ComposerPrefill = {
  text: string;
  token: number;
};

const HOME_DRAFT_KEY = "__home__";

type ComposerMenuView = "root" | "model" | "thinking";

type PromptEnhancementError = {
  message: string;
  code: string;
};

function draftKeyForSession(sessionId: string | null | undefined) {
  return sessionId ?? HOME_DRAFT_KEY;
}

export function Composer({
  variant = "docked",
  prefill,
}: {
  variant?: "home" | "docked";
  prefill?: ComposerPrefill | null;
}) {
  const { t } = useTranslation();
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const removeQueuedPrompt = useAppStore((s) => s.removeQueuedPrompt);
  const sendQueuedNow = useAppStore((s) => s.sendQueuedNow);
  const abort = useAppStore((s) => s.abort);
  const isRunning = useAppStore((s) => s.isRunning);
  const settings = useAppStore((s) => s.settings);
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const workspacePath = useAppStore((s) => s.workspace?.path ?? "");
  const providers = useAppStore((s) => s.providers);
  const providerModels = useAppStore((s) => s.providerModels);
  const loadProviderModels = useAppStore((s) => s.loadProviderModels);
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
  const [value, setValue] = useState("");
  const [fileReferences, setFileReferences] = useState<ComposerFileReference[]>([]);
  const [cursor, setCursor] = useState(0);
  // `onSelect` fires on every caret move, so an unchanged cursor must not
  // re-render the composer or re-run autocomplete trigger detection.
  const updateCursor = (next: number) =>
    setCursor((current) => (current === next ? current : next));
  const [composing, setComposing] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  // Clearing a draft releases the focus pause so guidance can resume after a
  // send, even when the textarea keeps focus. A new focus starts paused again.
  const placeholderFocusPauseReleasedRef = useRef(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const permissionRef = useRef<HTMLDivElement>(null);
  const [modelThinkingOpen, setModelThinkingOpen] = useState(false);
  const [modelThinkingView, setModelThinkingView] =
    useState<ComposerMenuView>("root");
  const [modelQuery, setModelQuery] = useState("");
  const [modelHighlight, setModelHighlight] = useState(-1);
  const [thinkingHighlight, setThinkingHighlight] = useState(-1);
  const modelThinkingRef = useRef<HTMLDivElement>(null);
  const rootMenuRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const thinkingListRef = useRef<HTMLDivElement>(null);
  const [pasting, setPasting] = useState(false);
  const [enhancingPrompt, setEnhancingPrompt] = useState(false);
  const [enhancementUndoText, setEnhancementUndoText] = useState<string | null>(null);
  const [enhancementError, setEnhancementError] =
    useState<PromptEnhancementError | null>(null);
  const enhancementVersionRef = useRef(0);
  const enhancementRequestRef = useRef<symbol | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const publishedDockHeightRef = useRef(-1);
  const draftKey = draftKeyForSession(activeSessionId);
  const draftCacheRef = useRef(new Map<string, ComposerDraftSnapshot>());
  const draftKeyRef = useRef(draftKey);
  const approvalPending = planCheckpoint?.status === "pending";
  const executionActive = isActivePlanExecution(planCheckpoint);
  const runActive = isRunning || executionActive;
  const inputBlocked = approvalPending || pasting;
  const controlsBlocked = approvalPending;
  const sendBlocked = approvalPending || pasting;
  const referenceSessionId = activeSessionId ?? "";
  const activeFileReferences = fileReferences.filter(
    (fileReference) => fileReference.sessionId === referenceSessionId,
  );
  const activeInlineFileReferences = activeFileReferences.filter(
    (fileReference) =>
      Boolean(fileReference.token && value.includes(fileReference.token)),
  );
  const activeChipFileReferences = activeFileReferences.filter(
    (fileReference) => !fileReference.token,
  );
  const placeholderKey =
    variant === "home"
      ? placeholderIndex === 0
        ? "chat.placeholderHome"
        : "chat.placeholderHomeHint"
      : placeholderIndex === 0
        ? "chat.placeholder"
        : "chat.placeholderHint";
  const placeholderText = t(placeholderKey);
  const placeholderPaused =
    value.length > 0 ||
    activeChipFileReferences.length > 0 ||
    activeInlineFileReferences.length > 0 ||
    composing ||
    (inputFocused && !placeholderFocusPauseReleasedRef.current);

  const invalidatePromptEnhancement = () => {
    enhancementVersionRef.current += 1;
    setEnhancementUndoText(null);
    setEnhancementError(null);
  };

  useEffect(() => {
    setPlaceholderIndex(0);
    placeholderFocusPauseReleasedRef.current = false;
  }, [variant]);

  useEffect(() => {
    if (placeholderPaused) return;
    const timer = window.setInterval(() => {
      setPlaceholderIndex((current) => (current + 1) % 2);
    }, PLACEHOLDER_CAROUSEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [placeholderPaused, variant]);

  // Keep a live ref so the draft cache can snapshot the latest value without
  // re-running a serialization effect on every keystroke.
  const valueRef = useRef(value);
  valueRef.current = value;
  const fileReferencesRef = useRef(fileReferences);
  fileReferencesRef.current = fileReferences;

  useEffect(() => {
    const previousKey = draftKeyRef.current;
    if (previousKey !== draftKey) {
      invalidatePromptEnhancement();
      // Persist the outgoing draft before switching.
      draftCacheRef.current.set(previousKey, {
        text: valueRef.current,
        fileReferences: fileReferencesRef.current
          .filter((fileReference) => fileReference.sessionId === previousKey)
          .map(({ path, name, kind, mimeType, token }) => ({
            path,
            name,
            kind,
            ...(mimeType ? { mimeType } : {}),
            ...(token ? { token } : {}),
          })),
      });
      draftKeyRef.current = draftKey;
      const nextDraft = draftCacheRef.current.get(draftKey);
      placeholderFocusPauseReleasedRef.current = false;
      setValue(nextDraft?.text ?? "");
      setFileReferences(
        nextDraft?.fileReferences.map((fileReference) =>
          createFileReference(
            fileReference.path,
            fileReference.name,
            referenceSessionId,
            fileReference,
          ),
        ) ?? [],
      );
      setCursor(nextDraft?.text.length ?? 0);
      return;
    }
    // For the current draftKey the cache is updated lazily (on switch or
    // snapshot) via valueRef/fileReferencesRef; no per-keystroke serialization.
  }, [draftKey, referenceSessionId]);

  // Keep the draft cache warm on file-reference changes (infrequent) while
  // skipping the expensive serialization on plain text edits.
  useEffect(() => {
    draftCacheRef.current.set(draftKey, {
      text: valueRef.current,
      fileReferences: fileReferences
        .filter((fileReference) => fileReference.sessionId === referenceSessionId)
        .map(({ path, name, kind, mimeType, token }) => ({
          path,
          name,
          kind,
          ...(mimeType ? { mimeType } : {}),
          ...(token ? { token } : {}),
        })),
    });
  }, [draftKey, fileReferences, referenceSessionId]);

  useEffect(() => {
    const sessionIds = new Set(sessions.map((session) => session.id));
    for (const key of draftCacheRef.current.keys()) {
      if (key !== HOME_DRAFT_KEY && key !== draftKey && !sessionIds.has(key)) {
        draftCacheRef.current.delete(key);
      }
    }
  }, [draftKey, sessions]);

  useEffect(() => {
    if (!controlsBlocked) return;
    setPermissionOpen(false);
    setModelThinkingOpen(false);
  }, [controlsBlocked]);

  useEffect(() => {
    // Relative autocomplete references belong to the workspace that produced
    // them. Session scratch references remain valid across project switches.
    setFileReferences((current) => {
      const next = current.filter((fileReference) => Boolean(fileReference.token));
      return next.length === current.length ? current : next;
    });
  }, [workspacePath]);

  useEffect(() => {
    if (!composerPrefill) return;
    if (composerPrefill.sessionId !== activeSessionId) return;
    setValue(composerPrefill.text);
    setFileReferences((current) => [
      ...current.filter(
        (fileReference) => fileReference.sessionId !== composerPrefill.sessionId,
      ),
      ...composerPrefill.fileReferences.map((fileReference) =>
        createFileReference(
          fileReference.path,
          fileReference.name,
          composerPrefill.sessionId,
          fileReference,
        ),
      ),
    ]);
    clearComposerPrefill();
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, [activeSessionId, composerPrefill, clearComposerPrefill]);

  useEffect(() => {
    if (!prefill?.text) return;
    setValue(prefill.text);
    setFileReferences([]);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
  }, [prefill]);

  const textareaMetricsRef = useRef<{ lineHeight: number; verticalChrome: number } | null>(null);
  // What this effect last wrote. Typing inside one row leaves the box exactly
  // as it was, and re-writing an unchanged height would still wake the dock
  // ResizeObserver below, which republishes a document-wide custom property.
  const appliedHeightRef = useRef<number | null>(null);
  const appliedOverflowRef = useRef<string | null>(null);
  // Invalidate cached metrics when the variant changes or a theme switch
  // alters CSS custom properties (font-size, line-height, padding).
  useEffect(() => {
    textareaMetricsRef.current = null;
    appliedHeightRef.current = null;
    appliedOverflowRef.current = null;
  }, [variant]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure wrapped visual lines, not newline characters. The draft starts
    // at one optical row, grows through seven rows, then scrolls internally.
    // Cache line-height and vertical chrome — they change only with CSS, never
    // during normal typing.
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
    // Trust the height already applied only if it is still on the element.
    const applied =
      appliedHeightRef.current !== null &&
      el.style.height === `${appliedHeightRef.current}px`
        ? appliedHeightRef.current
        : null;
    // Read the content at the height already applied: as long as it overflows
    // that box, this single reading is the full content height, which is all
    // the height and overflow decisions need.
    let content = applied === null ? -1 : el.scrollHeight;
    if (
      applied === null ||
      (content <= el.clientHeight && applied > COMPOSER_MIN_HEIGHT_PX)
    ) {
      // Deliberate measurement probe: only `height: auto` reveals that the
      // draft now needs fewer rows than the box still shows. It must never
      // stay applied, so the computed height is always written back below.
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

  useEffect(() => {
    if (!permissionOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (!permissionRef.current?.contains(e.target as Node))
        setPermissionOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPermissionOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [permissionOpen]);

  useEffect(() => {
    if (!modelThinkingOpen) {
      setModelThinkingView("root");
      setModelQuery("");
      setModelHighlight(-1);
      setThinkingHighlight(-1);
      return;
    }
    const onPointer = (e: MouseEvent) => {
      if (!modelThinkingRef.current?.contains(e.target as Node)) {
        setModelThinkingOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelThinkingOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [modelThinkingOpen]);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const draftConfiguration = useAppStore((s) => s.draftConfiguration);
  const mode: Mode = activeSession
    ? activeSession.mode
    : (draftConfiguration?.mode ?? settings?.defaultMode ?? "agent");
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
  const thinkingProvider =
    provider &&
    activeSession?.providerId === provider.id &&
    activeSession.modelId === modelId &&
    typeof activeSession.supportsReasoning === "boolean"
      ? {
          ...provider,
          supportsReasoning: activeSession.supportsReasoning,
          supportedThinkingLevels:
            activeSession.supportedThinkingLevels ?? (["off"] as ThinkingLevel[]),
        }
      : catalogThinkingProvider;
  // A draft without a session starts at the strongest level its inherited
  // default model publishes, matching a freshly created reasoning session.
  const draftThinkingLevel = thinkingProvider?.supportsReasoning
    ? highestSupportedThinkingLevel(thinkingProvider.supportedThinkingLevels)
    : "off";
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
  const thinkingLabel = t(THINKING_LEVEL_I18N_KEYS[thinkingLevel], {
    defaultValue: THINKING_LEVEL_LABELS[thinkingLevel],
  });
  const selectedModel = provider?.id
    ? composerModelsForProvider(provider, providerModels[provider.id]).find(
        (model) => model.modelId === modelId,
      )
    : undefined;
  const modelLabel = selectedModel?.displayName || modelId || t("chat.model");
  const thinkingMenuLevels: ThinkingLevel[] = availableThinkingLevels.length
    ? availableThinkingLevels
    : ["off"];
  const modelGroups = useMemo(() => providers
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
        models,
      };
    })
    .filter((group) => group.models.length > 0), [providers, providerModels]);
  const modelQueryNeedle = modelQuery.trim().toLowerCase();
  const filteredModelGroups = useMemo(() => modelQueryNeedle
    ? modelGroups
        .map((group) => ({
          ...group,
          models: group.models.filter(
            (model) =>
              model.modelId.toLowerCase().includes(modelQueryNeedle) ||
              (model.displayName ?? "").toLowerCase().includes(modelQueryNeedle) ||
              group.provider.name.toLowerCase().includes(modelQueryNeedle),
          ),
        }))
        .filter((group) => group.models.length > 0)
    : modelGroups, [modelGroups, modelQueryNeedle]);
  const flatModels = useMemo(() => filteredModelGroups.flatMap((group) =>
    group.models.map((model) => ({ provider: group.provider, model })),
  ), [filteredModelGroups]);
  const flatModelsKey = useMemo(() => flatModels
    .map((entry) => `${entry.provider.id}:${entry.model.modelId}`)
    .join("|"), [flatModels]);
  const activeFlatIndex = useMemo(() => flatModels.findIndex(
    (entry) => entry.provider.id === provider?.id && entry.model.modelId === modelId,
  ), [flatModels, provider?.id, modelId]);
  const modelReady =
    !!provider &&
    provider.enabled &&
    !!modelId &&
    (provider.hasSecret || provider.authKind === "none");
  const enterToSend = settings?.enterToSend ?? true;
  const largePasteThreshold = normalizeLargePasteThreshold(
    settings?.largePasteThreshold,
  );
  const hasDraftContent = Boolean(
    value.trim() ||
      activeChipFileReferences.length ||
      activeInlineFileReferences.length,
  );

  useEffect(() => {
    if (!modelThinkingOpen || modelThinkingView !== "model") return;
    setModelHighlight(modelQueryNeedle ? (flatModels.length ? 0 : -1) : activeFlatIndex);
  }, [
    activeFlatIndex,
    flatModels.length,
    flatModelsKey,
    modelQueryNeedle,
    modelThinkingOpen,
    modelThinkingView,
  ]);

  useEffect(() => {
    if (!modelThinkingOpen || modelThinkingView !== "thinking") return;
    setThinkingHighlight(thinkingLevel ? thinkingMenuLevels.indexOf(thinkingLevel) : -1);
  }, [modelThinkingOpen, modelThinkingView, thinkingLevel, thinkingMenuLevels]);

  useEffect(() => {
    if (!modelThinkingOpen) return;
    requestAnimationFrame(() => {
      if (modelThinkingView === "root") {
        rootMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
      if (modelThinkingView === "model") modelSearchRef.current?.focus();
      if (modelThinkingView === "thinking") {
        thinkingListRef.current
          ?.querySelector<HTMLButtonElement>("button")
          ?.focus();
      }
      if (modelThinkingView === "model" && modelHighlight >= 0) {
        modelListRef.current
          ?.querySelector(`[data-model-index="${modelHighlight}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
      if (modelThinkingView === "thinking" && thinkingHighlight >= 0) {
        thinkingListRef.current
          ?.querySelector(`[data-thinking-index="${thinkingHighlight}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    });
  }, [modelThinkingOpen, modelThinkingView]);

  useEffect(() => {
    if (!modelThinkingOpen || modelThinkingView !== "model" || modelHighlight < 0) return;
    modelListRef.current
      ?.querySelector(`[data-model-index="${modelHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [modelHighlight, modelThinkingOpen, modelThinkingView]);

  useEffect(() => {
    if (!modelThinkingOpen || modelThinkingView !== "thinking" || thinkingHighlight < 0)
      return;
    thinkingListRef.current
      ?.querySelector(`[data-thinking-index="${thinkingHighlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [modelThinkingOpen, modelThinkingView, thinkingHighlight]);

  useEffect(() => {
    if (!modelThinkingOpen || modelThinkingView !== "model") return;
    for (const candidate of providers) {
      if (candidate.enabled && (candidate.hasSecret || candidate.authKind === "none")) {
        void loadProviderModels(candidate.id);
      }
    }
  }, [loadProviderModels, modelThinkingOpen, modelThinkingView, providers]);

  const showModelThinkingView = (view: ComposerMenuView) => {
    setModelThinkingView(view);
    setModelHighlight(-1);
    setThinkingHighlight(-1);
    if (view !== "model") setModelQuery("");
  };

  const selectModel = async (
    candidate: (typeof providers)[number],
    nextModelId: string,
  ) => {
    try {
      const nextModelProvider = thinkingProviderForModel(
        candidate,
        nextModelId,
        providerModels[candidate.id],
      );
      const nextThinkingLevel = activeSession
        ? thinkingLevelForProvider(nextModelProvider, thinkingLevel)
        : nextModelProvider?.supportsReasoning
          ? highestSupportedThinkingLevel(nextModelProvider.supportedThinkingLevels)
          : "off";
      await configureActiveSession({
        mode,
        providerId: candidate.id,
        modelId: nextModelId,
        thinkingLevel: nextThinkingLevel,
      });
      setModelQuery("");
      setModelThinkingView("root");
      setModelHighlight(-1);
      setThinkingHighlight(-1);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const selectThinkingLevel = async (level: ThinkingLevel) => {
    try {
      await configureActiveSession({
        mode,
        providerId: provider?.id,
        modelId,
        thinkingLevel: level,
      });
      setModelThinkingView("root");
      setModelHighlight(-1);
      setThinkingHighlight(-1);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const onModelThinkingMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      setModelThinkingOpen(false);
      return;
    }
    if (e.key === "ArrowLeft" && modelThinkingView !== "root") {
      e.preventDefault();
      showModelThinkingView("root");
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") {
      if (
        e.key === "Enter" &&
        modelThinkingView === "model" &&
        e.target instanceof HTMLInputElement
      ) {
        const entry = flatModels[modelHighlight];
        if (entry) {
          e.preventDefault();
          void selectModel(entry.provider, entry.model.modelId);
        }
      }
      if (e.key === "Enter" && modelThinkingView === "thinking") {
        const level = thinkingMenuLevels[thinkingHighlight] ?? thinkingMenuLevels[0];
        if (level) {
          e.preventDefault();
          void selectThinkingLevel(level);
        }
      }
      return;
    }
    if (modelThinkingView === "root") return;
    e.preventDefault();
    if (modelThinkingView === "model") {
      if (!flatModels.length) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setModelHighlight((current) => {
        const base = current < 0 ? (delta > 0 ? -1 : flatModels.length) : current;
        return (base + delta + flatModels.length) % flatModels.length;
      });
      return;
    }
    if (!thinkingMenuLevels.length) return;
    const delta = e.key === "ArrowDown" ? 1 : -1;
    setThinkingHighlight((current) => {
      const base = current < 0 ? (delta > 0 ? -1 : thinkingMenuLevels.length) : current;
      return (base + delta + thinkingMenuLevels.length) % thinkingMenuLevels.length;
    });
  };

  const clearDraftForKey = (key: string) => {
    invalidatePromptEnhancement();
    draftCacheRef.current.delete(key);
    const currentKey = draftKeyForSession(useAppStore.getState().activeSessionId);
    if (currentKey !== key) return;
    placeholderFocusPauseReleasedRef.current = true;
    setValue("");
    setFileReferences((current) => {
      const next = current.filter(
        (fileReference) => fileReference.sessionId !== key,
      );
      return next.length === current.length ? current : next;
    });
    setCursor(0);
  };

  const draftSnapshot = (text: string): ComposerDraftSnapshot => ({
    text: text.trim(),
    fileReferences: activeFileReferences
      .filter((fileReference) =>
        !fileReference.token || text.includes(fileReference.token),
      )
      .map(({ path, name, kind, mimeType, token }) => ({
        path,
        name,
        kind,
        ...(mimeType ? { mimeType } : {}),
        ...(token ? { token } : {}),
      })),
  });

  const enhancePrompt = async () => {
    const sourceText = value;
    const sourceKey = draftKey;
    const sourceVersion = enhancementVersionRef.current;
    if (
      !sourceText.trim() ||
      sourceText.trim().startsWith("/") ||
      !modelReady ||
      sendBlocked ||
      activeInlineFileReferences.length > 0 ||
      enhancingPrompt
    ) {
      return;
    }

    const requestToken = Symbol("prompt-enhancement");
    enhancementRequestRef.current = requestToken;
    setEnhancingPrompt(true);
    setEnhancementUndoText(null);
    setEnhancementError(null);
    try {
      const result = await api.enhancePrompt({
        sessionId: activeSessionId,
        draft: sourceText,
        providerId: provider?.id,
        modelId,
        thinkingLevel,
      });
      const currentKey = draftKeyForSession(useAppStore.getState().activeSessionId);
      if (
        enhancementRequestRef.current !== requestToken ||
        currentKey !== sourceKey ||
        enhancementVersionRef.current !== sourceVersion
      ) {
        return;
      }
      const enhancedDraft = result.enhancedDraft.trim();
      if (!enhancedDraft) {
        throw Object.assign(new Error("The model returned an empty enhanced draft."), {
          code: "PROMPT_ENHANCEMENT_EMPTY",
        });
      }
      enhancementVersionRef.current += 1;
      setValue(enhancedDraft);
      setCursor(enhancedDraft.length);
      setEnhancementUndoText(sourceText);
      requestAnimationFrame(() => {
        const textarea = ref.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(enhancedDraft.length, enhancedDraft.length);
      });
    } catch (error) {
      const currentKey = draftKeyForSession(useAppStore.getState().activeSessionId);
      if (
        enhancementRequestRef.current !== requestToken ||
        currentKey !== sourceKey ||
        enhancementVersionRef.current !== sourceVersion
      ) {
        return;
      }
      const typed = error as Error & { code?: string };
      setEnhancementError({
        message: typed.message || t("chat.enhancementFailed"),
        code: typed.code || "PROMPT_ENHANCEMENT_FAILED",
      });
    } finally {
      if (enhancementRequestRef.current === requestToken) {
        setEnhancingPrompt(false);
      }
    }
  };

  const undoPromptEnhancement = () => {
    if (enhancementUndoText === null) return;
    invalidatePromptEnhancement();
    setValue(enhancementUndoText);
    setCursor(enhancementUndoText.length);
    requestAnimationFrame(() => {
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(enhancementUndoText.length, enhancementUndoText.length);
    });
  };

  const submit = async () => {
    const inlineContent = serializeInlineComposerFileReferences(
      value,
      activeFileReferences,
    );
    const serializedContent = serializeComposerFileReferences(value, activeFileReferences);
    if (!serializedContent || sendBlocked) return;
    invalidatePromptEnhancement();
    const submittedDraftKey = draftKey;
    // Slash dispatch (D123): builtin/plugin aliases execute locally without
    // a session or a model; templates and unknown /names stay prompt text
    // (main expands templates). Runs before the model-ready gate on purpose.
    if (serializedContent.startsWith("/")) {
      const commandEnd = serializedContent.search(/\s/);
      const name = serializedContent.slice(
        1,
        commandEnd === -1 ? undefined : commandEnd,
      );
      const command = name ? await resolveComposerCommand(name) : null;
      if (command && command.kind !== "template" && command.id) {
        const commandBody =
          commandEnd === -1 ? "" : serializedContent.slice(commandEnd).trim();
        const isModeCommand =
          command.id === "builtin.mode.agent" ||
          command.id === "builtin.mode.plan" ||
          command.id === "builtin.mode.goal";

        // Mode aliases can prefix a real prompt, e.g. `/plan-mode inspect
        // this change`. Switch first, then send only the prompt body through
        // the normal agent path so the user's message remains visible.
        if (isModeCommand && commandBody) {
          try {
            await runPaletteCommand(command.id);
            const visibleDraft = value.trim();
            const visibleCommandEnd = visibleDraft.search(/\s/);
            const visibleCommandBody =
              visibleCommandEnd === -1
                ? ""
                : visibleDraft.slice(visibleCommandEnd).trim();
            const accepted = await sendPrompt(
              serializeInlineComposerFileReferences(
                visibleCommandBody,
                activeFileReferences,
              ),
              draftSnapshot(visibleCommandBody),
            );
            if (accepted) clearDraftForKey(submittedDraftKey);
          } catch (e) {
            showToast(e instanceof Error ? e.message : String(e), {
              variant: "error",
            });
          }
          return;
        }

        // A local command is consumed only when it has no trailing text. A
        // command with unsupported arguments falls through as prompt text;
        // never silently discard a draft the user typed after the alias.
        if (!commandBody) {
          try {
            if (command.kind === "builtin") await runPaletteCommand(command.id);
            else await api.executeCommand(command.id);
            clearDraftForKey(submittedDraftKey);
          } catch (e) {
            showToast(e instanceof Error ? e.message : String(e), {
              variant: "error",
            });
          }
          return;
        }
      }
    }
    if (!modelReady) return;
    const accepted = await sendPrompt(inlineContent, draftSnapshot(value));
    if (accepted) clearDraftForKey(submittedDraftKey);
  };

  const pasteClipboardFiles = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (inputBlocked) return;
    const files = clipboardFiles(event.clipboardData);
    const text = event.clipboardData.getData("text/plain");
    const textLength = Array.from(text).length;
    const isLargeTextPaste = !files.length && textLength > largePasteThreshold;
    if (isLargeTextPaste) {
      event.preventDefault();
      const selectionStart = event.currentTarget.selectionStart ?? cursor;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      const sourceSessionId = activeSessionId;
      const sourceDraftKey = draftKey;
      const sourceValue = valueRef.current;
      const sourceReferenceSessionId = sourceSessionId ?? "";
      setPasting(true);
      try {
        let sessionId = sourceSessionId;
        if (!sessionId) {
          // Large text is real input: persist the draft so the file has a
          // durable session owner before it is written.
          sessionId = (await materializeDraftSession()) ?? "";
        }
        if (!sessionId) throw new Error("session unavailable");

        const bytes = new TextEncoder().encode(text);
        const data = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const name = `pasted-text-${crypto.randomUUID().slice(0, 8)}.txt`;
        const result = await api.pasteFiles(sessionId, [
          { name, mimeType: "text/plain", data },
        ]);
        const pasted = result.files[0];
        if (!pasted) throw new Error("temporary paste file was not created");

        const displayName = pasted.name || name;
        const token = `@${displayName}`;
        const nextValue =
          sourceValue.slice(0, selectionStart) +
          token +
          " " +
          sourceValue.slice(selectionEnd);
        const previousReferences = fileReferencesRef.current
          .filter((fileReference) => fileReference.sessionId === sourceReferenceSessionId)
          .map(({ path, name: referenceName, kind, mimeType, token: referenceToken }) => ({
            path,
            name: referenceName,
            kind,
            ...(mimeType ? { mimeType } : {}),
            ...(referenceToken ? { token: referenceToken } : {}),
          }));
        const nextSnapshot: ComposerDraftSnapshot = {
          text: nextValue,
          fileReferences: [
            ...previousReferences,
            {
              path: pasted.path,
              name: displayName,
              kind: "file",
              mimeType: pasted.mimeType,
              token,
            },
          ],
        };
        // Materialization can change the active session while the IPC call is
        // in flight. Cache the result by its durable target rather than
        // allowing a late response to contaminate another session's draft.
        draftCacheRef.current.set(sessionId, nextSnapshot);
        const currentSessionId = useAppStore.getState().activeSessionId;
        if (currentSessionId === sessionId) {
          setValue(nextValue);
          setFileReferences(
            nextSnapshot.fileReferences.map((fileReference) =>
              createFileReference(
                fileReference.path,
                fileReference.name,
                sessionId,
                fileReference,
              ),
            ),
          );
          setCursor(selectionStart + token.length + 1);
          requestAnimationFrame(() => {
            const el = ref.current;
            if (!el) return;
            el.focus();
            const nextCursor = selectionStart + token.length + 1;
            el.setSelectionRange(nextCursor, nextCursor);
          });
        } else if (sourceDraftKey === HOME_DRAFT_KEY) {
          // The home slot is intentionally not reused after materialization;
          // keep it empty while the new session owns the converted draft.
          draftCacheRef.current.delete(HOME_DRAFT_KEY);
        }
        showToast(t("chat.largeTextPasted", { name: displayName }), {
          variant: "success",
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      } finally {
        setPasting(false);
      }
      return;
    }
    if (!files.length) return;

    event.preventDefault();
    const selectionStart = event.currentTarget.selectionStart ?? cursor;
    const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
    setPasting(true);
    try {
      const payload = await Promise.all(
        files.map(async (file) => ({
          name: file.name || undefined,
          mimeType: file.type || undefined,
          data: await file.arrayBuffer(),
        })),
      );
      let sessionId = activeSessionId;
      if (!sessionId) {
        // Pasting files counts as real input: persist the draft so the files
        // have a session to attach to.
        sessionId = (await materializeDraftSession()) ?? "";
      }
      if (!sessionId) throw new Error("session unavailable");
      if (!activeSessionId) {
        setFileReferences((current) =>
          current.map((fileReference) =>
            fileReference.sessionId === ""
              ? { ...fileReference, sessionId }
              : fileReference,
          ),
        );
      }

      const result = await api.pasteFiles(sessionId, payload);
      setFileReferences((current) => [
        ...current,
        ...result.files.map((file) =>
          createFileReference(file.path, file.name, sessionId, {
            kind: file.kind,
            mimeType: file.mimeType,
          }),
        ),
      ]);
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(selectionStart, selectionEnd);
      });
      showToast(t("chat.filesPasted", { count: result.files.length }), {
        variant: "success",
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setPasting(false);
    }
  };

  const composerAc = useComposerAutocomplete({
    value,
    cursor,
    composing,
    enabled: !inputBlocked,
  });

  const acceptCompletion = (index: number) => {
    const result = composerAc.accept(index);
    if (!result) return;
    setValue(result.value);
    setCursor(result.cursor);
    const acceptedFileReference = result.fileReference;
    if (acceptedFileReference) {
      setFileReferences((current) => [
        ...current,
        createFileReference(
          acceptedFileReference.path,
          acceptedFileReference.name,
          referenceSessionId,
          { kind: isImageFilePath(acceptedFileReference.path) ? "image" : "file" },
        ),
      ]);
    }
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(result.cursor, result.cursor);
    });
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
        {queuedPrompts.length ? (
          <div
            className="composer-queued-prompts"
            role="list"
            aria-label={t("chat.queuedPrompts")}
          >
            {queuedPrompts.map((item) => {
              const label =
                item.content.trim() ||
                item.draft.fileReferences.map((reference) => reference.name).join(", ") ||
                t("chat.queuedPromptEmpty");
              return (
                <div
                  key={item.id}
                  className="composer-queued-prompt"
                  role="listitem"
                  data-testid="queued-prompt"
                >
                  <span className="composer-queued-prompt-text" title={label}>
                    {label}
                  </span>
                  <button
                    type="button"
                    className="composer-queued-prompt-action"
                    title={t("chat.removeQueuedPrompt")}
                    aria-label={t("chat.removeQueuedPrompt")}
                    onClick={() => removeQueuedPrompt(item.id)}
                  >
                    <IconX size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="composer-queued-prompt-send-now"
                    disabled={
                      approvalPending ||
                      (runActive && item.sendNowRequested === true)
                    }
                    onClick={() => void sendQueuedNow(item.id)}
                  >
                    {item.sendNowRequested
                      ? t("chat.sendNowPending")
                      : t("chat.sendNow")}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        {enhancementError ? (
          <div className="composer-enhancement-error" role="alert">
            <span className="composer-enhancement-error-message">
              {t("chat.enhancementFailed")}: {enhancementError.message}
            </span>
            <code>{enhancementError.code}</code>
            <button
              type="button"
              className="composer-enhancement-error-dismiss"
              title={t("chat.dismissEnhancementError")}
              aria-label={t("chat.dismissEnhancementError")}
              onClick={() => setEnhancementError(null)}
            >
              <IconX size={13} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <div className={`composer-shell${inputBlocked ? " is-gated" : ""}`}>
          {inputFocused ? (
            <ComposerAutocomplete ac={composerAc} onAccept={acceptCompletion} />
          ) : null}
          <div className="composer-input-wrap">
            {activeChipFileReferences.length ? (
              <div
                className="composer-file-references"
                role="list"
                aria-label={t("chat.fileReferences")}
              >
                {activeChipFileReferences.map((fileReference) => (
                  <div
                    key={fileReference.id}
                    className="composer-file-reference"
                    role="listitem"
                    title={fileReference.path}
                    aria-label={`${fileReference.name} — ${fileReference.path}`}
                  >
                    {fileReference.kind === "image" ? (
                      <IconImage size={13} aria-hidden />
                    ) : (
                      <IconFileText size={13} aria-hidden />
                    )}
                    <span className="composer-file-reference-name">
                      {fileReference.name}
                    </span>
                    <button
                      type="button"
                      className="composer-file-reference-remove"
                      title={t("chat.removeFileReference", {
                        name: fileReference.name,
                      })}
                      aria-label={t("chat.removeFileReference", {
                        name: fileReference.name,
                      })}
                      disabled={inputBlocked}
                      onClick={() => {
                        if (activeChipFileReferences.length === 1) {
                          placeholderFocusPauseReleasedRef.current = true;
                        }
                        setFileReferences((current) =>
                          current.filter(
                            (candidate) => candidate.id !== fileReference.id,
                          ),
                        );
                        requestAnimationFrame(() => ref.current?.focus());
                      }}
                    >
                      <IconX size={11} aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="composer-input-stage">
              <textarea
                ref={ref}
                className="composer-input"
                readOnly={inputBlocked}
                aria-readonly={inputBlocked}
                aria-busy={pasting}
                rows={2}
                placeholder={placeholderText}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                value={value}
                onPaste={pasteClipboardFiles}
                onChange={(e) => {
                  const nextValue = e.target.value;
                  invalidatePromptEnhancement();
                  placeholderFocusPauseReleasedRef.current = nextValue.length === 0;
                  setValue(nextValue);
                  // `filter` allocates even when it drops nothing, and a new
                  // array identity per keystroke re-runs the draft-cache
                  // serialization effect that keys off it.
                  setFileReferences((current) => {
                    const next = current.filter(
                      (fileReference) =>
                        !fileReference.token ||
                        nextValue.includes(fileReference.token),
                    );
                    return next.length === current.length ? current : next;
                  });
                  updateCursor(e.target.selectionStart ?? nextValue.length);
                }}
                onSelect={(e) => {
                  updateCursor(e.currentTarget.selectionStart ?? 0);
                }}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={(e) => {
                  setComposing(false);
                  updateCursor(e.currentTarget.selectionStart ?? 0);
                }}
                onFocus={() => {
                  placeholderFocusPauseReleasedRef.current = false;
                  setInputFocused(true);
                }}
                onBlur={() => {
                  placeholderFocusPauseReleasedRef.current = false;
                  setInputFocused(false);
                }}
                onKeyDown={(e) => {
                  // An Enter that confirms an IME candidate (isComposing, or the
                  // WebKit 229 quirk) must commit the text, never send it — and
                  // never drive the autocomplete menu (D125).
                  if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                    return;
                  if (
                    e.key === "Backspace" &&
                    value.length === 0 &&
                    activeChipFileReferences.length
                  ) {
                    e.preventDefault();
                    const lastReference = activeChipFileReferences.at(-1);
                    if (activeChipFileReferences.length === 1) {
                      placeholderFocusPauseReleasedRef.current = true;
                    }
                    setFileReferences((current) =>
                      current.filter(
                        (fileReference) => fileReference.id !== lastReference?.id,
                      ),
                    );
                    return;
                  }
                  if (composerAc.open && e.key === "Escape") {
                    // Escape closes only the menu; overlay handlers must not
                    // also fire on the same press.
                    e.preventDefault();
                    e.stopPropagation();
                    composerAc.close();
                    return;
                  }
                  if (composerAc.hasItems) {
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const delta = e.key === "ArrowDown" ? 1 : -1;
                      const count = composerAc.items.length;
                      composerAc.setHighlight(
                        (composerAc.highlight + delta + count) % count,
                      );
                      return;
                    }
                    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                      e.preventDefault();
                      acceptCompletion(composerAc.highlight);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey && enterToSend) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              {value.length === 0 ? (
                <span
                  key={`${variant}-${placeholderIndex}-${placeholderText}`}
                  className="composer-placeholder"
                  aria-hidden="true"
                >
                  {placeholderText}
                </span>
              ) : null}
            </div>
          </div>

          <div className="composer-toolbar">
            <div className="composer-left">
              <button
                className="icon-btn mode-chip composer-mode-chip"
                title={t("settings.mode")}
                disabled={controlsBlocked}
                onClick={async () => {
                  setModelThinkingOpen(false);
                  setPermissionOpen(false);
                  const next: Mode = nextMode(mode);
                  try {
                    await configureActiveSession({
                      mode: next,
                      providerId: provider?.id,
                      modelId,
                      thinkingLevel,
                    });
                  } catch (e) {
                    showToast(e instanceof Error ? e.message : String(e), {
                      variant: "error",
                    });
                  }
                }}
              >
                <ModeIcon mode={mode} />
                <span className="text-sm">{t(MODE_LABEL_KEYS[mode])}</span>
              </button>
              {mode === "agent" || mode === "plan" || mode === "goal" ? (
                <div className="composer-permission" ref={permissionRef}>
                  <button
                    className={`icon-btn mode-chip ${permissionOpen ? "active" : ""}`}
                    title={
                      mode === "goal"
                        ? `${t("chat.permissionMode")} · ${t("goal.autoWarning")}`
                        : mode === "plan" && composerPermissionMode === "auto"
                          ? `${t("chat.permissionMode")} · ${t("plan.autoWarning")}`
                          : t("chat.permissionMode")
                    }
                    aria-haspopup={mode === "goal" ? undefined : "menu"}
                    aria-expanded={mode === "goal" ? false : permissionOpen}
                    disabled={controlsBlocked || mode === "goal"}
                    onClick={() => {
                      setModelThinkingOpen(false);
                      setPermissionOpen((open) => !open);
                    }}
                  >
                    <span className="text-sm">
                      {t(PERMISSION_MODE_I18N_KEYS[composerPermissionMode])}
                    </span>
                    <IconChevronDown size={12} />
                  </button>
                  {permissionOpen && mode !== "goal" && (
                    <div className="composer-permission-menu" role="menu">
                      {(["ask", "accept-edits", "auto"] as const).map(
                        (candidate) => (
                          <button
                            key={candidate}
                            type="button"
                            role="menuitemradio"
                            aria-checked={composerPermissionMode === candidate}
                            disabled={controlsBlocked}
                            className={`composer-plus-item ${
                              composerPermissionMode === candidate ? "active" : ""
                            }`}
                            onClick={async () => {
                              setPermissionOpen(false);
                              try {
                                await configureActiveSession({
                                  mode,
                                  providerId: provider?.id,
                                  modelId,
                                  thinkingLevel,
                                  permissionMode: candidate,
                                });
                              } catch (e) {
                                showToast(
                                  e instanceof Error ? e.message : String(e),
                                  { variant: "error" },
                                );
                              }
                            }}
                          >
                            <span className="flex-1 text-left">
                              {t(PERMISSION_MODE_I18N_KEYS[candidate])}
                            </span>
                            {composerPermissionMode === candidate ? (
                              <IconCheck size={13} />
                            ) : null}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div className="composer-right">
              <div
                className="composer-model-thinking"
                ref={modelThinkingRef}
                onKeyDown={onModelThinkingMenuKeyDown}
              >
                <button
                  type="button"
                  className={`icon-btn composer-model-thinking-chip ${
                    modelThinkingOpen ? "active" : ""
                  }`}
                  title={`${modelLabel} · ${t("chat.reasoningLevel")}: ${thinkingLabel}`}
                  aria-label={`${t("chat.model")}: ${modelLabel}. ${t("chat.reasoningLevel")}: ${thinkingLabel}`}
                  aria-haspopup="menu"
                  aria-expanded={modelThinkingOpen}
                  disabled={controlsBlocked}
                  onClick={() => {
                    setPermissionOpen(false);
                    if (!modelThinkingOpen) {
                      setModelThinkingView("root");
                      setModelQuery("");
                      setModelHighlight(-1);
                      setThinkingHighlight(-1);
                    }
                    setModelThinkingOpen((open) => !open);
                  }}
                >
                  <span className="composer-model-thinking-icon" aria-hidden="true">
                    <IconBot size={14} />
                  </span>
                  <span className="composer-model-thinking-model">
                    {modelLabel}
                  </span>
                  {thinkingLevel !== "off" ? (
                    <>
                      <span className="composer-model-thinking-dot" aria-hidden="true">
                        ·
                      </span>
                      <span className="composer-model-thinking-level">
                        {thinkingLabel}
                      </span>
                    </>
                  ) : null}
                  <IconChevronDown size={12} aria-hidden="true" />
                </button>
                {modelThinkingOpen ? (
                  <div
                    className="composer-model-menu composer-model-thinking-menu"
                    role="menu"
                    aria-label={`${t("chat.model")} ${t("chat.reasoningLevel")}`}
                  >
                    {modelThinkingView === "root" ? (
                      <div className="composer-menu-root" ref={rootMenuRef}>
                        <button
                          type="button"
                          className="composer-menu-entry"
                          role="menuitem"
                          aria-haspopup="menu"
                          onClick={() => showModelThinkingView("model")}
                        >
                          <IconBot size={14} aria-hidden="true" />
                          <span className="composer-menu-entry-label">
                            {t("chat.model")}
                          </span>
                          <span
                            className="composer-menu-entry-value"
                            title={modelLabel}
                          >
                            {modelLabel}
                          </span>
                          <IconChevronRight size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="composer-menu-entry"
                          role="menuitem"
                          aria-haspopup="menu"
                          onClick={() => showModelThinkingView("thinking")}
                        >
                          <IconSparkles size={14} aria-hidden="true" />
                          <span className="composer-menu-entry-label">
                            {t("chat.reasoningLevel")}
                          </span>
                          <span className="composer-menu-entry-value">
                            {thinkingLabel}
                          </span>
                          <IconChevronRight size={14} aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="composer-menu-back"
                          role="menuitem"
                          onClick={() => showModelThinkingView("root")}
                        >
                          <IconChevronLeft size={14} aria-hidden="true" />
                          <span>
                            {modelThinkingView === "model"
                              ? t("chat.model")
                              : t("chat.reasoningLevel")}
                          </span>
                        </button>
                        <div className="composer-menu-separator" />
                        {modelThinkingView === "model" ? (
                          <>
                            <label className="composer-model-search">
                              <IconSearch size={13} aria-hidden="true" />
                              <span className="sr-only">{t("chat.searchModels")}</span>
                              <input
                                ref={modelSearchRef}
                                type="text"
                                value={modelQuery}
                                placeholder={t("chat.searchModels")}
                                aria-label={t("chat.searchModels")}
                                spellCheck={false}
                                autoCorrect="off"
                                autoCapitalize="off"
                                onChange={(e) => setModelQuery(e.target.value)}
                              />
                            </label>
                            <div className="composer-model-list" ref={modelListRef}>
                              {(() => {
                                let flatIndex = 0;
                                return filteredModelGroups.map((group) => (
                                  <div
                                    key={group.provider.id}
                                    className="composer-model-group"
                                    role="group"
                                    aria-label={group.provider.name}
                                  >
                                    <div className="composer-model-group-label">
                                      {group.provider.name}
                                    </div>
                                    {group.models.map((model) => {
                                      const index = flatIndex++;
                                      const active =
                                        provider?.id === group.provider.id &&
                                        modelId === model.modelId;
                                      const optionTitle =
                                        model.displayName || model.modelId;
                                      return (
                                        <button
                                          key={`${group.provider.id}:${model.modelId}`}
                                          type="button"
                                          data-model-index={index}
                                          title={optionTitle}
                                          className={`composer-plus-item composer-model-option ${
                                            active ? "active" : ""
                                          } ${
                                            modelHighlight === index ? "kb-active" : ""
                                          }`}
                                          role="menuitemradio"
                                          aria-checked={active}
                                          onMouseMove={() => setModelHighlight(index)}
                                          onClick={() =>
                                            void selectModel(group.provider, model.modelId)
                                          }
                                        >
                                          <span className="truncate">{optionTitle}</span>
                                          {active ? (
                                            <IconCheck
                                              size={14}
                                              className="composer-model-check"
                                              aria-hidden="true"
                                            />
                                          ) : null}
                                        </button>
                                      );
                                    })}
                                  </div>
                                ));
                              })()}
                              {flatModels.length === 0 ? (
                                <div className="composer-model-empty">
                                  {t("chat.noModelResults")}
                                </div>
                              ) : null}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="composer-thinking-heading">
                              {t("chat.reasoningSupportedBy", { model: modelLabel })}
                            </div>
                            <div className="composer-thinking-list" ref={thinkingListRef}>
                              {thinkingMenuLevels.map((level, index) => (
                                <button
                                  key={level}
                                  type="button"
                                  data-thinking-index={index}
                                  className={`composer-plus-item ${
                                    thinkingLevel === level ? "active" : ""
                                  } ${
                                    thinkingHighlight === index ? "kb-active" : ""
                                  }`}
                                  role="menuitemradio"
                                  aria-checked={thinkingLevel === level}
                                  onMouseMove={() => setThinkingHighlight(index)}
                                  onClick={() => void selectThinkingLevel(level)}
                                >
                                  <span className="flex-1">
                                    {t(THINKING_LEVEL_I18N_KEYS[level], {
                                      defaultValue: THINKING_LEVEL_LABELS[level],
                                    })}
                                  </span>
                                  {thinkingLevel === level ? (
                                    <IconCheck
                                      size={14}
                                      className="composer-model-check"
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={`icon-btn composer-enhance-btn${enhancingPrompt ? " is-loading" : ""}`}
                title={t("chat.enhancePrompt")}
                aria-label={
                  enhancingPrompt
                    ? t("chat.enhancingPrompt")
                    : t("chat.enhancePrompt")
                }
                aria-busy={enhancingPrompt}
                disabled={
                  !value.trim() ||
                  value.trim().startsWith("/") ||
                  !modelReady ||
                  sendBlocked ||
                  activeInlineFileReferences.length > 0 ||
                  enhancingPrompt
                }
                onClick={() => void enhancePrompt()}
              >
                {enhancingPrompt ? (
                  <>
                    <span className="tool-spinner" aria-hidden="true" />
                    <span>{t("chat.enhancingPrompt")}</span>
                  </>
                ) : (
                  <IconSparkles size={15} aria-hidden="true" />
                )}
              </button>
              {enhancementUndoText !== null ? (
                <button
                  type="button"
                  className="icon-btn composer-enhance-undo"
                  title={t("chat.undoEnhancement")}
                  aria-label={t("chat.undoEnhancement")}
                  disabled={controlsBlocked}
                  onClick={undoPromptEnhancement}
                >
                  <IconUndo2 size={15} aria-hidden="true" />
                </button>
              ) : null}
              {runActive && !hasDraftContent ? (
                <button
                  type="button"
                  className="stop-btn"
                  title={t("chat.stopGenerating")}
                  aria-label={t("chat.stopGenerating")}
                  onClick={() => void abort()}
                >
                  <IconStop size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="send-btn"
                  aria-label={modelReady ? t("chat.send") : t("settings.addProvider")}
                  title={
                    modelReady ? t("chat.send") : t("settings.addProvider")
                  }
                  disabled={
                    !hasDraftContent ||
                    sendBlocked ||
                    (!modelReady && !value.trim().startsWith("/"))
                  }
                  onClick={() => void submit()}
                >
                  <IconArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
