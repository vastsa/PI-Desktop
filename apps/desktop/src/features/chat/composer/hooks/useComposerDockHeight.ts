import { useEffect, useRef, type RefObject } from "react";

/** Only the main dock owns the transcript's bottom reserve. */
export function useComposerDockHeight(dockRef: RefObject<HTMLDivElement | null>, variant: string, enabled: boolean) {
  const publishedDockHeightRef = useRef(-1);
  // Keep the transcript's bottom reserve in sync with the composer's real
  // height (it grows with multi-line input) so the last message sits just
  // above the box instead of far below it.
  useEffect(() => {
    if (!enabled) return;
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
  }, [dockRef, variant, enabled]);
}
