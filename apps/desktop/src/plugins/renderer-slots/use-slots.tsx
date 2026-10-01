/**
 * React glue over the slot registry: subscriptions, the per-registration
 * error boundary that realizes 出错隔离 (a throwing component collapses only
 * its own region), and the mount element plugin styles are scoped to.
 */
import {
  Component,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { PluginComponentSlot, PluginSlotPosition } from "@pi-desktop/plugin-sdk";
import { slotRegistry, type SlotEntry } from "./registry";

/**
 * A registration's component as a React element with its slot's props. It is
 * an element, never a direct call, so the component's hooks belong to it.
 */
export function slotElement<Props extends object>(entry: SlotEntry, props: Props): ReactElement {
  return createElement(entry.component as FunctionComponent<Props>, props);
}

export function useSlotEntries(
  slot: PluginComponentSlot,
  side?: PluginSlotPosition,
): SlotEntry[] {
  const snapshot = useSyncExternalStore(
    slotRegistry.subscribe,
    slotRegistry.getSnapshot,
    slotRegistry.getSnapshot,
  );
  return useMemo(
    () => (side ? slotRegistry.entriesForSide(slot, side) : slotRegistry.entriesFor(slot)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot.version is the change signal
    [snapshot.version, slot, side],
  );
}

export function useSlotEntryForKey(
  slot: PluginComponentSlot,
  key: string | undefined,
): SlotEntry | undefined {
  const snapshot = useSyncExternalStore(
    slotRegistry.subscribe,
    slotRegistry.getSnapshot,
    slotRegistry.getSnapshot,
  );
  return useMemo(
    () => (key ? slotRegistry.entryForKey(slot, key) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot.version is the change signal
    [snapshot.version, slot, key],
  );
}

/**
 * The element a registration's component renders into. `data-pi-plugin` is
 * what `pi.ui.injectStyle` scopes the plugin's sheets to, so host chrome
 * around a slot (toggles, menus) stays outside of it.
 */
export function SlotMount({
  entry,
  children,
}: {
  entry: SlotEntry;
  children: ReactNode;
}) {
  return (
    <div className="pi-plugin-slot" data-pi-plugin={entry.pluginId} data-pi-slot={entry.slot}>
      {children}
    </div>
  );
}

/** A registration's component in its mount, inside its own error boundary. */
export function SlotBoundary({
  entry,
  children,
  fallback,
}: {
  entry: SlotEntry;
  children: ReactNode;
  /** Rendered instead when the component throws; nothing by default. */
  fallback?: ReactNode;
}) {
  return (
    <SlotErrorBoundary entry={entry} fallback={fallback}>
      <SlotMount entry={entry}>{children}</SlotMount>
    </SlotErrorBoundary>
  );
}

type BoundaryProps = { entry: SlotEntry; fallback?: ReactNode; children: ReactNode };

type BoundaryState = { failed: boolean };

/**
 * Catches what one registration's subtree throws while rendering and renders
 * `fallback` in its place from then on; outlets key it by `entry.id`, so a new
 * registration starts over.
 */
export class SlotErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    const { pluginId, slot } = this.props.entry;
    // Isolated by design; the console line is the diagnosability surface.
    console.warn(`[plugin-slot] ${pluginId} ${slot} component failed`, error);
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/**
 * Session identity for slot props. The transcript knows the session a
 * message belongs to; slot hosts pass it down through this context so the
 * props skeleton (`message/messageId/sessionId`) stays uniform.
 */
const SlotSessionContext = createContext<string>("");

export function SlotSessionProvider({
  sessionId,
  children,
}: {
  sessionId: string;
  children: ReactNode;
}) {
  return (
    <SlotSessionContext.Provider value={sessionId}>{children}</SlotSessionContext.Provider>
  );
}

export function useSlotSessionId(): string {
  return useContext(SlotSessionContext);
}
