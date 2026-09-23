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

type Choice = { open: boolean; revealRequest?: number };

/** Only explicit choices are retained; untouched nodes derive their defaults. */
class DisclosureChoices {
  private choices = new Map<string, Choice>();
  private listeners = new Map<string, Set<() => void>>();

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
const ParentContext = createContext<{ claim: () => void; visible: boolean }>({
  claim: () => {},
  visible: true,
});

/** The retained session pane owns this map; no state is persisted to the host. */
export function TranscriptDisclosureProvider({ children }: { children: ReactNode }) {
  const [choices] = useState(() => new DisclosureChoices());
  return <ChoicesContext.Provider value={choices}>{children}</ChoicesContext.Provider>;
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
  const parent = useContext(ParentContext);
  const subscribe = useCallback((listener: () => void) => choices.subscribe(key, listener), [choices, key]);
  const snapshot = useCallback(() => choices.get(key), [choices, key]);
  const choice = useSyncExternalStore(subscribe, snapshot, snapshot);
  // A pending reveal is the derived default, so the first paint (and SSR)
  // already shows the row the transcript search asked to open.
  const open = choice?.open ?? (
    revealRequest !== undefined && choice?.revealRequest !== revealRequest
      ? true
      : automaticOpen
  );
  const titleRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const notifyAnchor = useDisclosureAnchorNotifier();
  const currentOpen = useRef(open);
  currentOpen.current = open;

  const claim = useCallback(() => {
    if (!choices.get(key)) choices.set(key, { open: currentOpen.current });
    parent.claim();
  }, [choices, key, parent.claim]);

  useLayoutEffect(() => {
    if (revealRequest === undefined || choices.get(key)?.revealRequest === revealRequest) return;
    choices.set(key, { open: true, revealRequest });
    parent.claim();
  }, [choices, key, parent.claim, revealRequest]);

  const previousOpen = useRef(open);
  useLayoutEffect(() => {
    const closing = previousOpen.current && !open;
    previousOpen.current = open;
    if (!closing || choice) return;
    /*
      A close nobody asked for is the completion fold. Focus and an active
      selection win over it, and a reader who scrolled away keeps the header
      where it is: the transcript turns native scroll anchoring off, so the
      scroller has to hold the position explicitly (#324).
    */
    if (ownsReadingPosition(bodyRef.current)) {
      choices.set(key, { open: true });
      parent.claim();
      return;
    }
    notifyAnchor?.(titleRef.current, "automatic");
  }, [choice, choices, key, notifyAnchor, open, parent.claim]);

  const setManualOpen = useCallback((next: boolean) => {
    parent.claim();
    notifyAnchor?.(titleRef.current);
    if (!next && bodyRef.current?.contains(document.activeElement)) {
      titleRef.current?.focus({ preventScroll: true });
    }
    choices.set(key, { ...choices.get(key), open: next });
  }, [choices, key, notifyAnchor, parent.claim]);
  const toggle = useCallback(() => setManualOpen(!currentOpen.current), [setManualOpen]);
  const collapse = useCallback(() => setManualOpen(false), [setManualOpen]);

  return {
    open,
    toggle,
    collapse,
    claim,
    titleRef,
    bodyRef,
    parentVisible: parent.visible,
    // Pointer selection and keyboard interaction establish ownership before
    // a streaming update can apply an automatic close.
    bodyEvents: { onPointerDownCapture: claim, onFocusCapture: claim },
  };
}

export function DisclosureScope({
  disclosure,
  open = disclosure.open,
  children,
}: {
  disclosure: ReturnType<typeof useAutomaticDisclosure>;
  open?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({
    claim: disclosure.claim,
    visible: disclosure.parentVisible && open,
  }), [disclosure.claim, disclosure.parentVisible, open]);
  return <ParentContext.Provider value={value}>{children}</ParentContext.Provider>;
}
