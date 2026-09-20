import { useLayoutEffect, useSyncExternalStore } from "react";

// Native plugin views composite above the renderer, including its top layer.
// Count owners so dismissing one overlay cannot reveal a view under another.
const owners = new Set<symbol>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const isBlockingOverlayActive = () => owners.size > 0;

export function useBlockingOverlay() {
  useLayoutEffect(() => {
    const owner = Symbol();
    owners.add(owner);
    notify();
    return () => { owners.delete(owner); notify(); };
  }, []);
}

export function useBlockingOverlayActive() {
  return useSyncExternalStore(subscribe, isBlockingOverlayActive, () => false);
}
