import { useLayoutEffect, useRef } from "react";

export type PluginPanelGeometry = {
  width: number;
  resizing: boolean;
  /** Live reads include CSS entry/exit animation geometry. */
  element?: Pick<HTMLElement, "getBoundingClientRect" | "getAnimations">;
};

/** Reports actual mounted geometry without publishing every animation frame. */
export function useWorkPanelGeometry(
  width: number,
  resizing: boolean,
  onChange?: (geometry: PluginPanelGeometry | null) => void,
) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !onChange) return;
    const notify = () => onChange({ width, resizing, element });
    const animationEnded = (event: AnimationEvent) => {
      if (event.target === element) notify();
    };
    element.addEventListener("animationend", animationEnded);
    element.addEventListener("animationcancel", animationEnded);
    notify();
    return () => {
      element.removeEventListener("animationend", animationEnded);
      element.removeEventListener("animationcancel", animationEnded);
      onChange(null);
    };
  }, [width, resizing, onChange]);
  return ref;
}
