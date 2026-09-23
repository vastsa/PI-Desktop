import { useCallback, useLayoutEffect, useRef } from "react";

/** Publish after the editor's layout effects so the reserve is ready for paint. */
export function useComposerDockHeight(variant: "home" | "docked") {
  const dockRef = useRef<HTMLDivElement>(null);
  const publishedHeightRef = useRef(-1);
  const publish = useCallback(() => {
    const element = dockRef.current;
    if (!element) return;
    const height = Math.round(element.getBoundingClientRect().height);
    // Settings retains this component beneath a hidden ancestor. Keep the last
    // real reserve until it is visible again; zero is not a measured dock size.
    if (height <= 0) return;
    // Root custom properties invalidate document-wide styles; skip equal pixels.
    if (height === publishedHeightRef.current) return;
    publishedHeightRef.current = height;
    document.documentElement.style.setProperty("--composer-dock-height", `${height}px`);
  }, []);

  // Drafts, attachments and status rows can all resize the dock in a commit.
  // Measure once per layout phase, without waiting for ResizeObserver delivery.
  useLayoutEffect(publish);

  useLayoutEffect(() => {
    const element = dockRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, [publish, variant]);

  return dockRef;
}
