import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useDisclosureAnchorNotifier } from "../../../lib/disclosure-anchor-context";
import { sessionReadingState, type TranscriptDisclosureChoice } from "../../../lib/transcript-reading-position";
import { ScopeContext, type DisclosureScopeValue } from "./disclosure-scope";

type Choice = TranscriptDisclosureChoice;

/** Only explicit choices are retained; untouched nodes derive their defaults. */
class DisclosureChoices {
  private choices: Map<string, Choice>;
  private listeners = new Map<string, Set<() => void>>();

  constructor(choices = new Map<string, Choice>()) {
    this.choices = choices;
  }

  get = (key: string) => this.choices.get(key);

  set(key: string, choice: Choice) {
    const previous = this.choices.get(key);
    if (previous?.open === choice.open && previous.revealRequest === choice.revealRequest) return;
    this.choices.set(key, choice);
    this.listeners.get(key)?.forEach((listener) => listener());
  }

  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }
}

const ChoicesContext = createContext<DisclosureChoices | null>(null);
const PaneVisibilityContext = createContext(true);

/*
 * A level's own visibility is a second gate beside the stored choice, so a
 * collapsed parent closes everything it reveals without erasing - or even
 * overriding - a child's explicit choice. Reopening the parent restores the
 * rows the user had opened, which is what a nested disclosure should do.
 */
export type { DisclosureScopeValue } from "./disclosure-scope";

/** Explicit choices survive pane eviction, but never persist to the host. */
export function TranscriptDisclosureProvider({ children, sessionId, visible = true }: {
  children: ReactNode;
  sessionId?: string;
  visible?: boolean;
}) {
  const parentVisible = useContext(PaneVisibilityContext);
  const [choices] = useState(() => new DisclosureChoices(
    sessionId ? sessionReadingState(sessionId).disclosures : undefined,
  ));
  return <ChoicesContext.Provider value={choices}>
    <PaneVisibilityContext.Provider value={parentVisible && visible}>{children}</PaneVisibilityContext.Provider>
  </ChoicesContext.Provider>;
}

/** Mounted transcript descendants suspend work while their pane or scope is hidden. */
export function useTranscriptVisibility() {
  const paneVisible = useContext(PaneVisibilityContext);
  return useContext(ScopeContext).visible && paneVisible;
}

export function disclosureKey(kind: string, ...ids: string[]) {
  return JSON.stringify([kind, ...ids]);
}

function ownsReadingPosition(body: HTMLElement | null): boolean {
  if (!body) return false;
  if (body.contains(document.activeElement)) return true;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && (
    body.contains(selection.anchorNode) || body.contains(selection.focusNode)
  ));
}

export function useAutomaticDisclosure(
  automaticOpen: boolean,
  revealRequest?: number,
  identity?: string,
) {
  const sharedChoices = useContext(ChoicesContext);
  const [localChoices] = useState(() => new DisclosureChoices());
  const choices = sharedChoices ?? localChoices;
  const fallbackId = useId();
  const key = identity ?? fallbackId;
  const subscribe = useCallback((listener: () => void) => choices.subscribe(key, listener), [choices, key]);
  const snapshot = useCallback(() => choices.get(key), [choices, key]);
  const choice = useSyncExternalStore(subscribe, snapshot, snapshot);
  // A pending reveal is the derived default, so the first paint (and SSR)
  // already shows the row the transcript search asked to open.
  const requestedOpen = choice?.open ?? (
    revealRequest !== undefined && choice?.revealRequest !== revealRequest
      ? true
      : automaticOpen
  );
  const scope = useContext(ScopeContext);
  const paneVisible = useContext(PaneVisibilityContext);
  // A level below a collapsed parent renders nothing, whatever its own choice
  // says. The choice is left untouched so reopening the parent restores it.
  const open = requestedOpen && scope.visible;

  const titleRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const notifyAnchor = useDisclosureAnchorNotifier();
  const currentOpen = useRef(open);
  currentOpen.current = open;

  // The claim goes to the level that owns this one, not to the root: opening a
  // row inside a process disclosure has to keep that process open too.
  const claim = useCallback(() => {
    if (!choices.get(key)) choices.set(key, { open: currentOpen.current });
    scope.claim();
  }, [choices, key, scope.claim]);

  useLayoutEffect(() => {
    if (revealRequest === undefined || choices.get(key)?.revealRequest === revealRequest) return;
    choices.set(key, { open: true, revealRequest });
    scope.claim();
  }, [choices, key, scope.claim, revealRequest]);

  const previousOpen = useRef(open);
  useLayoutEffect(() => {
    // Completion must not hide keyboard focus or an active text selection.
    if (previousOpen.current && !open && !choice && ownsReadingPosition(bodyRef.current)) {
      choices.set(key, { open: true });
      scope.claim();
    }
    previousOpen.current = open;
  }, [choice, choices, key, open, scope.claim]);

  const setManualOpen = useCallback((next: boolean) => {
    scope.claim();
    notifyAnchor?.(titleRef.current);
    if (!next && bodyRef.current?.contains(document.activeElement)) {
      titleRef.current?.focus({ preventScroll: true });
    }
    choices.set(key, { ...choices.get(key), open: next });
  }, [choices, key, notifyAnchor, scope.claim]);
  const toggle = useCallback(() => setManualOpen(!currentOpen.current), [setManualOpen]);
  const collapse = useCallback(() => setManualOpen(false), [setManualOpen]);

  return {
    open,
    toggle,
    collapse,
    claim,
    titleRef,
    bodyRef,
    // Kept for callers that read the parent's visibility directly; the scope
    // itself already folded it into `open`.
    parentVisible: scope.visible,
    // Pane suspension is independent from the stored disclosure/open state.
    workVisible: scope.visible && paneVisible,
    // Pointer selection and keyboard interaction establish ownership before
    // a streaming update can apply an automatic close.
    bodyEvents: { onPointerDownCapture: claim, onFocusCapture: claim },
  };
}

/**
 * Reveal a level's contents to the disclosures nested inside it.
 *
 * The scope states both who owns this level's reveals and whether they are
 * currently shown, so a nested level needs no knowledge of its ancestors: a
 * collapsed whole-turn process closes every group under it, while each group
 * keeps the choice the user made for it.
 */
export function DisclosureScope({
  disclosure,
  open = disclosure.open,
  children,
}: {
  disclosure: ReturnType<typeof useAutomaticDisclosure>;
  open?: boolean;
  children: ReactNode;
}) {
  const value = useMemo<DisclosureScopeValue>(() => ({
    claim: disclosure.claim,
    visible: open,
  }), [disclosure.claim, open]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}
