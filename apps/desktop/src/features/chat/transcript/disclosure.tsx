import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

/*
 * A level's own visibility is a second gate beside the stored choice, so a
 * collapsed parent closes everything it reveals without erasing - or even
 * overriding - a child's explicit choice. Reopening the parent restores the
 * rows the user had opened, which is what a nested disclosure should do.
 */
export type { DisclosureScopeValue } from "./disclosure-scope";

/** Explicit choices survive pane eviction, but never persist to the host. */
export function TranscriptDisclosureProvider({ children, sessionId }: { children: ReactNode; sessionId?: string }) {
  const [choices] = useState(() => new DisclosureChoices(
    sessionId ? sessionReadingState(sessionId).disclosures : undefined,
  ));
  return <ChoicesContext.Provider value={choices}>{children}</ChoicesContext.Provider>;
}

export function disclosureKey(kind: string, ...ids: string[]) {
  return JSON.stringify([kind, ...ids]);
}

/**
 * Whether a reader is still inside these levels.
 *
 * Keyboard focus anywhere in the level - including the title of a row nested
 * under it - and an active text selection both count: an automatic close must
 * never hide content the reader is using.
 */
function ownsReadingPosition(...levels: Array<HTMLElement | null>): boolean {
  const active = document.activeElement;
  if (levels.some((level) => Boolean(level && active && level.contains(active)))) return true;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && levels.some((level) => Boolean(
    level && (level.contains(selection.anchorNode) || level.contains(selection.focusNode)),
  )));
}

/*
 * One listener set for every disclosure in the transcript. Each level only
 * re-reads its own DOM, so a focus or selection change costs a handful of
 * `contains` checks instead of one listener pair per row, and a level can never
 * miss the event that releases its hold because its effect had not run yet.
 */
const readingSyncs = new Set<() => void>();
let readingHubInstalled = false;
function installReadingHub() {
  if (readingHubInstalled || typeof document === "undefined") return;
  readingHubInstalled = true;
  const syncAll = () => {
    for (const sync of [...readingSyncs]) sync();
  };
  document.addEventListener("focusin", syncAll);
  document.addEventListener("selectionchange", syncAll);
  window.addEventListener("pointerup", syncAll);
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
  const scope = useContext(ScopeContext);

  const titleRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const notifyAnchor = useDisclosureAnchorNotifier();

  /*
   * Reading protection is transient state, never a disclosure choice. It is
   * derived from the DOM: focus or a selection inside the level defers an
   * automatic close, and leaving the level hands control straight back to the
   * automatic default. Recording those moments as choices is what used to
   * disable automatic folding for the rest of the pane's life.
   */
  const [reading, setReading] = useState(false);

  // A pending reveal is the derived default, so the first paint (and SSR)
  // already shows the row the transcript search asked to open.
  const derivedOpen = revealRequest !== undefined && choice?.revealRequest !== revealRequest
    ? true
    : automaticOpen;
  // An explicit choice is authoritative. Without one, a reader inside the level
  // defers an automatic close without changing what the default would be.
  const requestedOpen = choice ? choice.open : (derivedOpen || reading);
  const open = requestedOpen && scope.visible;

  const currentOpen = useRef(open);
  currentOpen.current = open;

  const ownsReading = useCallback(
    () => ownsReadingPosition(bodyRef.current),
    [],
  );
  const syncReading = useCallback(
    () => setReading(ownsReadingPosition(bodyRef.current)),
    [],
  );

  useEffect(() => {
    installReadingHub();
    readingSyncs.add(syncReading);
    return () => {
      readingSyncs.delete(syncReading);
    };
  }, [syncReading]);

  // The claim goes to the level that owns this one, not to the root: reading a
  // row inside a process disclosure has to keep that process open too.
  const claim = useCallback(() => {
    installReadingHub();
    syncReading();
    scope.claim();
  }, [scope.claim, syncReading]);

  // A revealed path stays open: the reader asked for that content, and closing
  // the search must not take it away again.
  const reveal = useCallback(() => {
    if (!choices.get(key)) choices.set(key, { open: true });
    scope.reveal();
  }, [choices, key, scope.reveal]);

  useLayoutEffect(() => {
    if (revealRequest === undefined || choices.get(key)?.revealRequest === revealRequest) return;
    choices.set(key, { open: true, revealRequest });
    scope.reveal();
  }, [choices, key, scope.reveal, revealRequest]);

  // Completion must not hide keyboard focus or an active text selection. The
  // reader can arrive without the pointer/focus events above (find in page,
  // restored selection), so the transition checks the DOM itself.
  const previousDerived = useRef(derivedOpen);
  useLayoutEffect(() => {
    if (!choice && previousDerived.current && !derivedOpen && ownsReading()) setReading(true);
    previousDerived.current = derivedOpen;
  }, [choice, derivedOpen, ownsReading]);

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
    reveal,
    titleRef,
    bodyRef,
    // Kept for callers that read the parent's visibility directly; the scope
    // itself already folded it into `open`.
    parentVisible: scope.visible,
    // Pointer and keyboard interaction re-check the reading hold before a
    // streaming update can apply an automatic close.
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
    reveal: disclosure.reveal,
    visible: open,
  }), [disclosure.claim, disclosure.reveal, open]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}
