import { create } from "zustand";
import { isModeRunOpen, type ModeCatalog, type ModeRun } from "@pi-desktop/shared";

/**
 * Mode catalog and per-session run state (ADR mode-definitions).
 *
 * Kept out of the central app store: the catalog is pushed by Electron main
 * and the runs by host-core, and nothing else in the renderer writes them.
 * Ordering rules live here so every writer (load, event, control result)
 * goes through the same stale-result guard.
 */
type ModesState = {
  catalog: ModeCatalog | null;
  /** Open or last-known run per session; `null` means the Host has none. */
  runs: Record<string, ModeRun | null>;
};

export const useModesStore = create<ModesState>(() => ({ catalog: null, runs: {} }));

let catalogEvents = 0;
const runEvents = new Map<string, number>();

/** True when `next` may replace `current` for the same session. */
export function runSupersedes(current: ModeRun | null | undefined, next: ModeRun | null): boolean {
  if (!current || !next) return true;
  if (current.id !== next.id) return true;
  return next.revision >= current.revision;
}

export function setModeCatalog(catalog: ModeCatalog): void {
  catalogEvents += 1;
  useModesStore.setState({ catalog });
}

/** Load the catalog; a push that lands while the request is in flight wins. */
export async function loadModeCatalog(read: () => Promise<ModeCatalog | null>): Promise<void> {
  const seen = catalogEvents;
  const catalog = await read();
  if (catalog && seen === catalogEvents) useModesStore.setState({ catalog });
}

function writeRun(sessionId: string, run: ModeRun | null): { closed: boolean } {
  const current = useModesStore.getState().runs[sessionId];
  if (!runSupersedes(current, run)) return { closed: false };
  const wasOpen = !!current && isModeRunOpen(current.state);
  const isOpen = !!run && isModeRunOpen(run.state);
  useModesStore.setState((state) => ({ runs: { ...state.runs, [sessionId]: run } }));
  return { closed: wasOpen && !isOpen };
}

/** A pushed run (or a control/resolve answer) for one session. */
export function applyModeRun(sessionId: string, run: ModeRun | null): { closed: boolean } {
  runEvents.set(sessionId, (runEvents.get(sessionId) ?? 0) + 1);
  return writeRun(sessionId, run);
}

/**
 * Load a session's run. A push that arrives while the request is in flight is
 * newer than the answer, so the answer is dropped.
 */
export async function loadModeRun(
  sessionId: string,
  read: (sessionId: string) => Promise<ModeRun | null>,
): Promise<void> {
  const seen = runEvents.get(sessionId) ?? 0;
  const run = await read(sessionId);
  if ((runEvents.get(sessionId) ?? 0) !== seen) return;
  writeRun(sessionId, run);
}

export function openModeRun(sessionId: string | null | undefined): ModeRun | null {
  if (!sessionId) return null;
  const run = useModesStore.getState().runs[sessionId];
  return run && isModeRunOpen(run.state) ? run : null;
}
